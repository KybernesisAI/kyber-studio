/**
 * OrbApp — the floating orb's renderer. GPT-Live-1, client delegation.
 *
 * WebRTC runs here (it needs a browser context), but the SDP handshake and the
 * OpenAI key live in main: we create an offer, hand its SDP to
 * window.studio.voiceConnect, and get the answer back. The Live model handles
 * the spoken conversation; when it needs real work it emits
 * `session.delegation.created`, and we run the user's request on the agent
 * (window.studio.voiceAsk → Sid) and speak the result back with
 * `session.commentary.append`. That is where all tools, connectors, and memory
 * (the Gmail access) live.
 *
 * Event names in the Live stream are logged verbatim ([orb-evt]) so the exact
 * shapes can be confirmed against a live run.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { SiriOrb, type OrbState } from "../components/SiriOrb";
import "./OrbApp.css";

interface LiveEvent {
  type: string;
  [k: string]: unknown;
}

export function OrbApp(): React.ReactElement {
  const [state, setState] = useState<OrbState>("connecting");
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState("connecting…");

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const transcriptRef = useRef("");
  const agentNameRef = useRef("agent");
  const mutedRef = useRef(false);
  const startedRef = useRef(false);

  const send = useCallback((obj: Record<string, unknown>): void => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(obj));
  }, []);

  const handleDelegation = useCallback(
    async (delegationId: string | null): Promise<void> => {
      const request = transcriptRef.current.trim();
      transcriptRef.current = "";
      console.log(`[orb] delegation ${delegationId} request="${request.slice(0, 160)}"`);
      if (!request) {
        send({
          type: "session.commentary.append",
          event_id: `c_${Date.now()}`,
          delegation_id: delegationId,
          content: "Sorry, I didn't catch that — could you say it again?",
        });
        return;
      }
      setState("thinking");
      setStatus("…");
      send({
        type: "session.thinking.append",
        event_id: `t_${Date.now()}`,
        delegation_id: delegationId,
        content: "One moment.",
      });
      try {
        const result = await window.studio.voiceAsk({ text: request });
        send({
          type: "session.commentary.append",
          event_id: `c_${Date.now()}`,
          delegation_id: delegationId,
          content: result.reply,
        });
      } catch (err) {
        send({
          type: "session.commentary.append",
          event_id: `c_${Date.now()}`,
          delegation_id: delegationId,
          content: `I couldn't reach ${agentNameRef.current}: ${(err as Error).message}`,
        });
      }
    },
    [send],
  );

  const handleEvent = useCallback(
    (evt: LiveEvent): void => {
      // Verbatim log so the exact Live event shapes are visible in a run.
      console.log(`[orb-evt] ${JSON.stringify(evt).slice(0, 300)}`);
      const type = evt.type;

      // Accumulate the user's transcript however the Live stream names it.
      if (/input.*transcript.*(delta|done)/.test(type) && typeof evt.delta === "string") {
        transcriptRef.current += evt.delta;
        return;
      }
      if (/input.*transcript/.test(type) && typeof evt.transcript === "string") {
        transcriptRef.current += evt.transcript;
        return;
      }

      switch (type) {
        case "session.created":
        case "session.updated":
          setState((s) => (s === "connecting" ? "listening" : s));
          setStatus("listening");
          break;
        case "input_audio_buffer.speech_started":
          setState("listening");
          setStatus("listening");
          break;
        case "input_audio_buffer.speech_stopped":
          setState("thinking");
          break;
        case "session.delegation.created": {
          const delegation = evt.delegation as { id?: string } | undefined;
          void handleDelegation(delegation?.id ?? null);
          break;
        }
        case "session.commentary.appended":
        case "session.thinking.appended":
        case "session.instructions.appended":
          break; // acks
        case "error": {
          const message =
            (evt.error as { message?: string } | undefined)?.message ?? JSON.stringify(evt.error ?? evt);
          setState("error");
          setStatus(message.slice(0, 120));
          console.log(`[orb] realtime error: ${message}`);
          break;
        }
        default:
          if (/output.*(audio|transcript)/.test(type)) {
            setState("speaking");
            setStatus(`${agentNameRef.current} speaking`);
          } else if (type.endsWith("response.done") || type === "response.completed") {
            setState("listening");
            setStatus("listening");
          }
          break;
      }
    },
    [handleDelegation],
  );

  const bindChannel = useCallback(
    (dc: RTCDataChannel): void => {
      dcRef.current = dc;
      dc.onopen = () => {
        setState("listening");
        setStatus("listening");
        console.log("[orb] data channel open");
      };
      dc.onmessage = (e) => {
        try {
          handleEvent(JSON.parse(e.data) as LiveEvent);
        } catch {
          // Non-JSON keepalive — ignore.
        }
      };
    },
    [handleEvent],
  );

  const teardown = useCallback((): void => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    try {
      const ctx = await window.studio.voiceContext();
      if (ctx?.agentName) agentNameRef.current = ctx.agentName;

      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioElRef.current = audioEl;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
      };

      pc.addTrack(mic.getAudioTracks()[0], mic);

      // Client creates the events channel; also accept a server-created one.
      bindChannel(pc.createDataChannel("oai-events"));
      pc.ondatachannel = (e) => bindChannel(e.channel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const { sdp: answer } = await window.studio.voiceConnect({ sdp: offer.sdp ?? "" });
      await pc.setRemoteDescription({ type: "answer", sdp: answer });

      // Mic level meter for the "listening" animation.
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(mic);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = (): void => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(mutedRef.current ? 0 : Math.min(1, rms * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      setState("error");
      setStatus((err as Error).message.slice(0, 140));
      console.log(`[orb] connect failed: ${(err as Error).message}`);
    }
  }, [bindChannel]);

  const toggleMute = useCallback((): void => {
    const mic = micRef.current;
    if (!mic) return;
    mutedRef.current = !mutedRef.current;
    mic.getAudioTracks().forEach((t) => (t.enabled = !mutedRef.current));
    setStatus(mutedRef.current ? "muted" : "listening");
  }, []);

  /**
   * Grab the orb to move the window; a press that doesn't move is a mute toggle.
   * We drive the move in JS (screen-space deltas → main) rather than a CSS drag
   * region, because a drag region swallows the click and you lose mute-on-tap.
   */
  const onOrbMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      if (e.button !== 0) return;
      const startX = e.screenX;
      const startY = e.screenY;
      let lastX = startX;
      let lastY = startY;
      let moved = false;
      const onMove = (ev: MouseEvent): void => {
        const dx = ev.screenX - lastX;
        const dy = ev.screenY - lastY;
        lastX = ev.screenX;
        lastY = ev.screenY;
        if (dx || dy) window.studio.moveOrb({ dx, dy });
        if (Math.hypot(ev.screenX - startX, ev.screenY - startY) > 4) moved = true;
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        // A tap with no drag toggles mute; a drag just moved the window.
        if (!moved) toggleMute();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [toggleMute],
  );

  const end = useCallback((): void => {
    teardown();
    void window.studio.closeOrb();
  }, [teardown]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void connect();
    const off = window.studio.onVoiceActivity((label) => {
      if (label) setStatus(label);
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") end();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
      teardown();
    };
  }, [connect, end, teardown]);

  return (
    <div className="orb-window" onMouseDown={onOrbMouseDown}>
      <button className="orb-close" title="End (Esc)" onMouseDown={(e) => e.stopPropagation()} onClick={end}>
        ×
      </button>
      <SiriOrb state={state} size="sm" audioLevel={level} />
      <div className="orb-status">{status}</div>
    </div>
  );
}
