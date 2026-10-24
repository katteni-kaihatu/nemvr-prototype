extends Node
## PCM voice over a Pion WebRTC data channel. Godot's WebRTC API does not
## expose media tracks, so 20 ms mono s16 frames are relayed as binary packets.

signal state_changed(state: String)

const RATE := 48000
const FRAME_SAMPLES := 960
const FRAME_SECONDS := 0.02

var enabled: bool = false
var state: String = "off"
var pc: WebRTCPeerConnection
var channel: WebRTCDataChannel
var http: HTTPRequest
var capture: AudioEffectCapture
var microphone: AudioStreamPlayer
var playback_player: AudioStreamPlayer
var playback: AudioStreamGeneratorPlayback
var _clock: float = 0.0
var _bus: int = -1
var _offer_type: String = ""
var _offer_sdp: String = ""
var _candidates: Array[String] = []

func start(server_url: String) -> void:
	if enabled or server_url.is_empty():
		return
	enabled = true
	_set_state("connecting")
	http = HTTPRequest.new()
	add_child(http)
	pc = WebRTCPeerConnection.new()
	if pc.initialize({"iceServers": []}) != OK:
		print("VOICE_ERROR initialize")
		_set_state("unavailable")
		return
	pc.session_description_created.connect(_on_local_description)
	pc.ice_candidate_created.connect(_on_ice_candidate)
	channel = pc.create_data_channel("voice", {})
	if pc.create_offer() != OK:
		print("VOICE_ERROR create_offer")
		_set_state("unavailable")
		return
	_setup_audio()
	_exchange_offer.call_deferred(server_url)

func stop() -> void:
	enabled = false
	if channel != null:
		channel.close()
	if pc != null:
		pc.close()
	if microphone != null:
		microphone.stop()
	if _bus >= 0:
		AudioServer.set_bus_mute(_bus, true)
	pc = null
	channel = null
	playback = null
	_set_state("off")

func _set_state(value: String) -> void:
	state = value
	print("VOICE_STATE ", value)
	state_changed.emit(value)

func _setup_audio() -> void:
	capture = AudioEffectCapture.new()
	capture.buffer_length = 0.5
	_bus = AudioServer.bus_count
	AudioServer.add_bus()
	AudioServer.set_bus_name(_bus, "VoiceCapture")
	AudioServer.add_bus_effect(_bus, capture)
	AudioServer.set_bus_mute(_bus, true)
	microphone = AudioStreamPlayer.new()
	microphone.stream = AudioStreamMicrophone.new()
	microphone.bus = "VoiceCapture"
	add_child(microphone)
	microphone.play()

	var generator := AudioStreamGenerator.new()
	generator.mix_rate = RATE
	generator.buffer_length = 0.25
	playback_player = AudioStreamPlayer.new()
	playback_player.stream = generator
	playback_player.bus = "Master"
	playback_player.volume_db = 0.0
	add_child(playback_player)
	playback_player.play()
	playback = playback_player.get_stream_playback() as AudioStreamGeneratorPlayback

func _on_local_description(type: String, sdp: String) -> void:
	_offer_type = type
	_offer_sdp = sdp
	pc.set_local_description(type, sdp)

func _on_ice_candidate(_mid: String, _mline: int, candidate: String) -> void:
	if not candidate.is_empty():
		_candidates.append(candidate)

func _exchange_offer(server_url: String) -> void:
	var deadline: int = Time.get_ticks_msec() + 3000
	while pc != null and (_offer_sdp.is_empty() or pc.get_gathering_state() != WebRTCPeerConnection.GATHERING_STATE_COMPLETE):
		if Time.get_ticks_msec() > deadline:
			break
		await get_tree().process_frame
	if _offer_sdp.is_empty():
		print("VOICE_ERROR no offer sdp")
		_set_state("unavailable")
		return
	var sdp: String = _offer_sdp
	for candidate: String in _candidates:
		sdp += "a=" + candidate + "\r\n"
	var local: Dictionary = {"type": _offer_type, "sdp": sdp}
	var base: String = _http_base(server_url)
	var url: String = base + "/voice/offer?room=main"
	var error: int = http.request(url, ["content-type: application/json"], HTTPClient.METHOD_POST, JSON.stringify(local))
	if error != OK:
		print("VOICE_ERROR request ", error)
		_set_state("unavailable")
		return
	var response: Array = await http.request_completed
	var code: int = int(response[1])
	var body: PackedByteArray = response[3]
	if code != 200:
		print("VOICE_ERROR http ", code, " ", body.get_string_from_utf8())
		_set_state("unavailable")
		return
	var answer: Variant = JSON.parse_string(body.get_string_from_utf8())
	if not answer is Dictionary or not answer.has("sdp") or not answer.has("type"):
		print("VOICE_ERROR answer ", answer)
		_set_state("unavailable")
		return
	if pc.set_remote_description(str(answer["type"]), str(answer["sdp"])) != OK:
		print("VOICE_ERROR set remote")
		_set_state("unavailable")
		return
	_set_state("online")

func _http_base(server_url: String) -> String:
	var base: String = server_url.trim_suffix("/ws").trim_suffix("/")
	if base.begins_with("wss://"):
		return "https://" + base.substr(6)
	if base.begins_with("ws://"):
		return "http://" + base.substr(5)
	return base

func _process(delta: float) -> void:
	if not enabled or pc == null:
		return
	pc.poll()
	if channel != null:
		channel.poll()
		_receive()
	_clock += delta
	while _clock >= FRAME_SECONDS:
		_clock -= FRAME_SECONDS
		_send()

func _send() -> void:
	if channel == null or channel.get_ready_state() != WebRTCDataChannel.STATE_OPEN or capture == null:
		return
	var frames: PackedVector2Array = capture.get_buffer(FRAME_SAMPLES)
	if frames.size() < FRAME_SAMPLES:
		return
	var bytes := PackedByteArray()
	bytes.resize(FRAME_SAMPLES * 2)
	for i in FRAME_SAMPLES:
		var sample: float = clampf((frames[i].x + frames[i].y) * 0.5, -1.0, 1.0)
		bytes.encode_s16(i * 2, int(sample * 32767.0))
	channel.put_packet(bytes)

func _receive() -> void:
	while channel.get_available_packet_count() > 0:
		var packet: PackedByteArray = channel.get_packet()
		if packet.size() < 2 or playback == null:
			continue
		var count: int = packet.size() / 2
		for i in count:
			var sample: float = float(packet.decode_s16(i * 2)) / 32768.0
			playback.push_frame(Vector2(sample, sample))
