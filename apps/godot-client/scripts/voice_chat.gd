extends Node
## PCM voice over a Pion WebRTC data channel. Godot's WebRTC API does not
## expose media tracks, so 20 ms mono s16 frames are relayed as binary packets.

signal state_changed(state: String)

const FRAME_SECONDS := 0.01
const RATE := 48000
const FRAME_SAMPLES := 480

var enabled: bool = false
var state: String = "off"
var pc: WebRTCPeerConnection
var channel: WebRTCDataChannel
var http: HTTPRequest
var playback_player: AudioStreamPlayer
var playback: AudioStreamGeneratorPlayback
var sample_rate: int = RATE
var frame_samples: int = FRAME_SAMPLES
var _clock: float = 0.0
var _play_clock: float = 0.0

var input_level: float = 0.0
var output_level: float = 0.0
var _output_peak: float = 0.0
var _meter_only: bool = false
var _offer_type: String = ""
var _offer_sdp: String = ""
var _candidates: Array[String] = []
var _received_packets: int = 0
var _rx_queue: Array[PackedByteArray] = []
var _rx_started: bool = false
var _record: FileAccess
var _test_tone: bool = false
var _tone_phase: float = 0.0
var _sent_packets: int = 0


func start_meter(input_device: String = "") -> void:
	if enabled:
		return
	if not input_device.is_empty():
		AudioServer.set_input_device(input_device)
	_set_input(input_device)
	enabled = true
	_meter_only = true
	_setup_playback()
	_set_state("meter")

func start(server_url: String, input_device: String = "", test_tone: bool = false) -> void:
	var record_path: String = OS.get_environment("PROTO_VOICE_RECORD")
	if not record_path.is_empty():
		_record = FileAccess.open(record_path, FileAccess.WRITE)
	if enabled or server_url.is_empty():
		return
	if not input_device.is_empty():
		AudioServer.set_input_device(input_device)
	_set_input(input_device)
	enabled = true
	_meter_only = false
	_test_tone = test_tone
	_set_state("connecting")
	var manager := Engine.get_singleton("GDExtensionManager") if Engine.has_singleton("GDExtensionManager") else null
	if manager != null and manager.has_method("load_extension"):
		manager.load_extension("res://webrtc_native.gdextension")
	http = HTTPRequest.new()
	add_child(http)
	pc = WebRTCPeerConnection.new()
	if pc.initialize({"iceServers": [
		{"urls": ["stun:nemvr.nemnomi.dev:3478", "stun:stun.l.google.com:19302"]},
		{"urls": ["turn:nemvr.nemnomi.dev:3478?transport=udp"], "username": "voice", "credential": "devvoice"}
	]}) != OK:
		print("VOICE_ERROR initialize")
		_set_state("unavailable")
		return
	pc.session_description_created.connect(_on_local_description)
	pc.ice_candidate_created.connect(_on_ice_candidate)
	# Ordered/reliable delivery prevents reordered PCM frames from sounding
	# robotic. Keep frames short so retransmission stalls stay bounded.
	channel = pc.create_data_channel("voice", {"ordered": true})
	if pc.create_offer() != OK:
		print("VOICE_ERROR create_offer")
		_set_state("unavailable")
		return
	_setup_playback()
	_exchange_offer.call_deferred(server_url)

func stop() -> void:
	enabled = false
	input_level = 0.0
	output_level = 0.0
	_output_peak = 0.0
	_rx_queue.clear()
	_rx_started = false
	if channel != null:
		channel.close()
	if pc != null:
		pc.close()
	AudioServer.set_input_device_active(false)
	if playback_player != null:
		playback_player.stop()
		playback_player.queue_free()
		playback_player = null
	pc = null
	channel = null
	playback = null
	_meter_only = false
	_set_state("off")

func _set_state(value: String) -> void:
	if value == "off" and _record != null:
		_record.close()
		_record = null
	state = value
	state_changed.emit(value)

func _set_input(input_device: String) -> void:
	if not input_device.is_empty():
		AudioServer.set_input_device(input_device)
	AudioServer.set_input_device_active(true)

func _setup_playback() -> void:
	sample_rate = RATE
	frame_samples = FRAME_SAMPLES
	var generator := AudioStreamGenerator.new()
	generator.mix_rate = RATE
	generator.buffer_length = 0.15
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

func _http_base(server_url: String) -> String:
	var base: String = server_url.trim_suffix("/ws").trim_suffix("/")
	if base.begins_with("wss://"):
		return "https://" + base.substr(6)
	if base.begins_with("ws://"):
		return "http://" + base.substr(5)
	return base

func _process(delta: float) -> void:
	if not enabled:
		return
	if pc != null:
		pc.poll()
	if channel != null:
		channel.poll()
		if channel.get_ready_state() == WebRTCDataChannel.STATE_OPEN and state != "online":
			_set_state("online")
		if pc.get_connection_state() == WebRTCPeerConnection.STATE_FAILED and state != "unavailable":
			_set_state("unavailable")
		_receive()
	_play_clock += delta
	while _play_clock >= FRAME_SECONDS:
		_play_clock -= FRAME_SECONDS
		_pump_playback()
	_clock += delta
	while _clock >= FRAME_SECONDS:
		_clock -= FRAME_SECONDS
		_send()

func get_input_level() -> float:
	return input_level

func get_output_level() -> float:
	return output_level

func _send() -> void:
	if _test_tone:
		var tone := PackedByteArray()
		tone.resize(frame_samples * 2)
		for i in frame_samples:
			var sample: float = sin(_tone_phase) * 0.25
			_tone_phase = fmod(_tone_phase + TAU * 440.0 / float(sample_rate), TAU)
			tone.encode_s16(i * 2, int(sample * 32767.0))
		input_level = 0.25
		output_level = maxf(output_level * 0.8, clampf(_output_peak * 2.5, 0.0, 1.0))
		_output_peak = 0.0
		if channel != null and channel.get_ready_state() == WebRTCDataChannel.STATE_OPEN:
			var sent_tone: int = channel.put_packet(tone)
			if sent_tone == OK and _sent_packets == 0:
				_sent_packets = 1
				print("VOICE_TX audio started")
		return
	var input_rate: int = int(AudioServer.get_input_mix_rate())
	if input_rate <= 0:
		input_rate = RATE
	var needed: int = maxi(1, int(round(input_rate * FRAME_SECONDS)))
	var available: int = AudioServer.get_input_frames_available()
	if available < needed:
		input_level = lerpf(input_level, 0.0, 0.2)
		output_level = maxf(output_level * 0.8, clampf(_output_peak * 2.5, 0.0, 1.0))
		_output_peak = 0.0
		return
	var frames: PackedVector2Array = AudioServer.get_input_frames(needed)
	if frames.size() < 2:
		input_level = lerpf(input_level, 0.0, 0.2)
		return
	var peak: float = 0.0
	for i in frames.size():
		peak = maxf(peak, absf((frames[i].x + frames[i].y) * 0.5))
	input_level = lerpf(input_level, clampf(peak * 2.5, 0.0, 1.0), 0.4)
	output_level = maxf(output_level * 0.8, clampf(_output_peak * 2.5, 0.0, 1.0))
	_output_peak = 0.0
	if channel == null or channel.get_ready_state() != WebRTCDataChannel.STATE_OPEN:
		return
	var bytes := PackedByteArray()
	bytes.resize(FRAME_SAMPLES * 2)
	var ratio: float = float(frames.size()) / float(FRAME_SAMPLES)
	for i in FRAME_SAMPLES:
		var position: float = float(i) * ratio
		var left: int = mini(int(position), frames.size() - 1)
		var right: int = mini(left + 1, frames.size() - 1)
		var weight: float = position - float(left)
		var x: float = lerpf(frames[left].x, frames[right].x, weight)
		var y: float = lerpf(frames[left].y, frames[right].y, weight)
		var sample: float = clampf((x + y) * 0.5, -1.0, 1.0)
		bytes.encode_s16(i * 2, int(sample * 32767.0))
	var sent: int = channel.put_packet(bytes)
	if sent == OK and _sent_packets == 0:
		_sent_packets = 1
		print("VOICE_TX audio started")

func _receive() -> void:
	while channel.get_available_packet_count() > 0:
		var packet: PackedByteArray = channel.get_packet()
		if packet.size() < 2 or playback == null:
			continue
		_received_packets += 1
		if _received_packets == 1:
			print("VOICE_RX audio started size=", packet.size(), " playback=", playback)

		var count: int = packet.size() / 2
		var peak: float = 0.0
		for i in count:
			peak = maxf(peak, absf(float(packet.decode_s16(i * 2)) / 32768.0))
		_output_peak = maxf(_output_peak, peak)
		if _record != null:
			_record.store_buffer(packet)
		_rx_queue.append(packet)
		while _rx_queue.size() > 25:
			_rx_queue.pop_front()

func _pump_playback() -> void:
	if playback == null or _rx_queue.is_empty():
		return
	if not _rx_started:
		# Prebuffer a few 10 ms packets before starting playback. This absorbs
		# TURN jitter without adding a large fixed delay.
		if _rx_queue.size() < 4:
			return
		_rx_started = true
	var packet: PackedByteArray = _rx_queue[0]
	var count: int = packet.size() / 2
	if playback.get_frames_available() < count:
		return
	_rx_queue.pop_front()
	for i in count:
		var sample: float = float(packet.decode_s16(i * 2)) / 32768.0
		playback.push_frame(Vector2(sample, sample))
