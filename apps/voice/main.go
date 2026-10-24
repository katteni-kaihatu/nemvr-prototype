package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

var roomPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

type room struct {
	mu    sync.Mutex
	peers map[*peer]struct{}
}

type peer struct {
	pc *webrtc.PeerConnection
	dc *webrtc.DataChannel
}

var (
	roomsMu sync.Mutex
	rooms   = map[string]*room{}
)

func getRoom(name string) *room {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	r := rooms[name]
	if r == nil {
		r = &room{peers: map[*peer]struct{}{}}
		rooms[name] = r
	}
	return r
}

func (r *room) add(p *peer) {
	r.mu.Lock()
	r.peers[p] = struct{}{}
	r.mu.Unlock()
}

func (r *room) remove(p *peer) {
	r.mu.Lock()
	delete(r.peers, p)
	r.mu.Unlock()
}

func (r *room) broadcast(sender *peer, data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for p := range r.peers {
		if p == sender || p.dc.ReadyState() != webrtc.DataChannelStateOpen {
			continue
		}
		if err := p.dc.Send(data); err != nil {
			log.Printf("send: %v", err)
		}
	}
}

func main() {
	publicIP := os.Getenv("PUBLIC_IP")
	if publicIP == "" {
		log.Fatal("PUBLIC_IP is required")
	}
	udp, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: 3480})
	if err != nil {
		log.Fatal(err)
	}
	mux := ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: udp})
	setting := webrtc.SettingEngine{}
	setting.SetICEUDPMux(mux)
	setting.SetNAT1To1IPs([]string{publicIP}, webrtc.ICECandidateTypeHost)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(setting))

	muxHTTP := http.NewServeMux()
	muxHTTP.HandleFunc("/voice/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	muxHTTP.HandleFunc("/voice/offer", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		roomName := r.URL.Query().Get("room")
		if roomName == "" {
			roomName = "main"
		}
		if !roomPattern.MatchString(roomName) {
			http.Error(w, "invalid room", http.StatusBadRequest)
			return
		}
		var offer webrtc.SessionDescription
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&offer); err != nil {
			http.Error(w, "invalid offer", http.StatusBadRequest)
			return
		}
		log.Printf("voice offer room=%s", roomName)
		turnURL := "turn:" + publicIP + ":3478?transport=udp"
		pc, err := api.NewPeerConnection(webrtc.Configuration{
			ICEServers: []webrtc.ICEServer{{
				URLs:       []string{turnURL},
				Username:   "voice",
				Credential: "devvoice",
			}},
		})
		if err != nil {
			http.Error(w, "peer connection failed", http.StatusInternalServerError)
			return
		}
		pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
			if candidate != nil {
				log.Printf("ice candidate room=%s %s", roomName, candidate.String())
			}
		})
		p := &peer{pc: pc}
		space := getRoom(roomName)
		pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			p.dc = dc
			dc.OnOpen(func() {
				space.add(p)
				log.Printf("voice join room=%s label=%s", roomName, dc.Label())
			})
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				if len(msg.Data) > 0 {
					space.broadcast(p, msg.Data)
				}
			})
		})
		pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
			log.Printf("ice state room=%s %s", roomName, state)
		})
		pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
			if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
				space.remove(p)
				_ = pc.Close()
			}
		})
		if err := pc.SetRemoteDescription(offer); err != nil {
			http.Error(w, "set offer failed", http.StatusBadRequest)
			_ = pc.Close()
			return
		}
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			http.Error(w, "answer failed", http.StatusInternalServerError)
			_ = pc.Close()
			return
		}
		if err := pc.SetLocalDescription(answer); err != nil {
			http.Error(w, "local description failed", http.StatusInternalServerError)
			_ = pc.Close()
			return
		}
		<-webrtc.GatheringCompletePromise(pc)
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(pc.LocalDescription())
		log.Printf("voice answer room=%s", roomName)
	})

	log.Printf("voice relay listening on 127.0.0.1:8092, ICE udp 3480, public %s", publicIP)
	log.Fatal(http.ListenAndServe("127.0.0.1:8092", muxHTTP))
}
