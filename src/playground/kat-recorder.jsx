import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';

/*
 * KAT stage recorder (self-hosted scratch-gui addition, not upstream).
 *
 * Records the STAGE canvas to a .webm video, mixing in the project's own sounds and (optionally) the
 * pupil's microphone narration, then offers a download. Self-contained: it reads the VM from the store
 * (like KatVmExposer) and renders its own floating control, so it touches NO vendored scratch-gui
 * component and survives upstream merges.
 *
 * Pipeline: stage canvas.captureStream() for video; a MediaStreamDestination fed by the audio engine's
 * inputNode (all project sounds) plus an optional mic source; combined into one MediaStream -> MediaRecorder.
 */

const MAX_SECONDS = 180; // 3 minutes, keeps files small

const CLAY = '#b2401d';
const PINE = '#2f6f4e';
const REC_RED = '#d92d20';
const INK = '#241f1a';
const LINE = '#e7ded2';

function pickMime () {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
    ];
    return candidates.find(c => {
        try {
            return MediaRecorder.isTypeSupported(c);
        } catch (e) {
            return false;
        }
    }) || '';
}

function fmt (s) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
}

const btn = (bg, extra) => Object.assign({
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    padding: '8px 14px',
    font: '600 13px system-ui, sans-serif',
    cursor: 'pointer'
}, extra || {});

class KatRecorder extends React.Component {
    constructor (props) {
        super(props);
        this.state = {phase: 'idle', useMic: false, elapsed: 0, videoUrl: null, error: null};
        this.openSetup = this.openSetup.bind(this);
        this.cancel = this.cancel.bind(this);
        this.toggleMic = this.toggleMic.bind(this);
        this.start = this.start.bind(this);
        this.stop = this.stop.bind(this);
        this.finish = this.finish.bind(this);
        this.download = this.download.bind(this);
        this.reset = this.reset.bind(this);
    }
    componentWillUnmount () {
        this.teardown();
        if (this.state.videoUrl) URL.revokeObjectURL(this.state.videoUrl);
    }
    openSetup () {
        this.setState({phase: 'setup', error: null});
    }
    cancel () {
        this.setState({phase: 'idle'});
    }
    toggleMic () {
        this.setState(s => ({useMic: !s.useMic}));
    }
    async start () {
        const vm = this.props.vm;
        const canvas = vm && vm.renderer && vm.renderer.canvas;
        const audioEngine = vm && vm.runtime && vm.runtime.audioEngine;
        const audioCtx = audioEngine && audioEngine.audioContext;
        if (!canvas || !audioCtx || typeof MediaRecorder === 'undefined') {
            this.setState({phase: 'idle', error: 'Recording is not supported here.'});
            return;
        }
        try {
            if (audioCtx.state === 'suspended') await audioCtx.resume();

            const videoStream = canvas.captureStream(30);
            this._videoStream = videoStream;

            // Tap all project sounds without muting playback: inputNode stays connected to the speakers.
            const dest = audioCtx.createMediaStreamDestination();
            audioEngine.inputNode.connect(dest);
            this._dest = dest;

            if (this.state.useMic) {
                try {
                    const micStream = await navigator.mediaDevices.getUserMedia({audio: true});
                    this._micStream = micStream;
                    this._micSource = audioCtx.createMediaStreamSource(micStream);
                    this._micSource.connect(dest);
                } catch (e) {
                    // Mic blocked/denied: keep going with project audio only.
                }
            }

            const combined = new MediaStream([
                ...videoStream.getVideoTracks(),
                ...dest.stream.getAudioTracks()
            ]);
            const mimeType = pickMime();
            const rec = new MediaRecorder(combined, mimeType ? {mimeType} : undefined);
            this._chunks = [];
            rec.ondataavailable = e => {
                if (e.data && e.data.size) this._chunks.push(e.data);
            };
            rec.onstop = this.finish;
            rec.start();
            this._recorder = rec;
            this._startTime = Date.now();
            this.setState({phase: 'recording', elapsed: 0, error: null});
            this._timer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
                this.setState({elapsed});
                if (elapsed >= MAX_SECONDS) this.stop();
            }, 500);
        } catch (e) {
            this.teardown();
            this.setState({phase: 'idle', error: 'Could not start recording.'});
        }
    }
    stop () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._recorder && this._recorder.state !== 'inactive') {
            this._recorder.stop(); // -> onstop -> finish()
        } else {
            this.finish();
        }
    }
    teardown () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        try {
            const ae = this.props.vm && this.props.vm.runtime && this.props.vm.runtime.audioEngine;
            if (ae && this._dest) ae.inputNode.disconnect(this._dest); // only our tap, never the speakers
        } catch (e) { /* ignore */ }
        if (this._micSource) {
            try {
                this._micSource.disconnect();
            } catch (e) { /* ignore */ }
            this._micSource = null;
        }
        if (this._micStream) {
            this._micStream.getTracks().forEach(t => t.stop());
            this._micStream = null;
        }
        if (this._videoStream) {
            this._videoStream.getTracks().forEach(t => t.stop());
            this._videoStream = null;
        }
        this._dest = null;
    }
    finish () {
        this.teardown();
        const type = (this._recorder && this._recorder.mimeType) || 'video/webm';
        this._recorder = null;
        const chunks = this._chunks || [];
        this._chunks = [];
        if (!chunks.length) {
            this.setState({phase: 'idle', error: 'Nothing was recorded. Try again.'});
            return;
        }
        const blob = new Blob(chunks, {type});
        this.setState({phase: 'done', videoUrl: URL.createObjectURL(blob)});
    }
    download () {
        if (!this.state.videoUrl) return;
        const a = document.createElement('a');
        a.href = this.state.videoUrl;
        a.download = 'my-scratch-video.webm';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    reset () {
        if (this.state.videoUrl) URL.revokeObjectURL(this.state.videoUrl);
        this.setState({phase: 'idle', videoUrl: null, elapsed: 0, error: null});
    }
    render () {
        if (typeof MediaRecorder === 'undefined') return null; // unsupported browser: hide entirely
        const {phase, useMic, elapsed, videoUrl, error} = this.state;
        const anchor = {
            position: 'fixed', right: '16px', bottom: '88px', zIndex: 9998,
            fontFamily: 'system-ui, sans-serif'
        };
        const card = {
            background: '#fff', color: INK, border: `1px solid ${LINE}`, borderRadius: '14px',
            boxShadow: '0 10px 30px rgba(36,31,26,.22)', padding: '14px', width: '260px'
        };

        if (phase === 'recording') {
            return (
                <div style={anchor}>
                    <div style={Object.assign({}, card, {display: 'flex', alignItems: 'center', gap: '10px', width: 'auto'})}>
                        <span style={{width: '12px', height: '12px', borderRadius: '50%', background: REC_RED, animation: 'katrecpulse 1s infinite'}} />
                        <span style={{font: '600 14px system-ui', fontVariantNumeric: 'tabular-nums'}}>{fmt(elapsed)}</span>
                        <button type="button" style={btn(REC_RED)} onClick={this.stop}>{'Stop'}</button>
                        <style>{'@keyframes katrecpulse{0%,100%{opacity:1}50%{opacity:.35}}'}</style>
                    </div>
                </div>
            );
        }

        if (phase === 'setup') {
            return (
                <div style={anchor}>
                    <div style={card}>
                        <div style={{fontWeight: 700, fontSize: '14px', marginBottom: '8px'}}>{'Record your stage'}</div>
                        <label style={{display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer'}}>
                            <input type="checkbox" checked={useMic} onChange={this.toggleMic} />
                            {'Use microphone (narration)'}
                        </label>
                        <p style={{fontSize: '12px', color: '#6b6157', margin: '8px 0 12px'}}>
                            {'Press the green flag to run your project while you record.'}
                        </p>
                        <div style={{display: 'flex', gap: '8px'}}>
                            <button type="button" style={btn(CLAY)} onClick={this.start}>{'Start recording'}</button>
                            <button type="button" style={btn('#efe9e0', {color: INK})} onClick={this.cancel}>{'Cancel'}</button>
                        </div>
                    </div>
                </div>
            );
        }

        if (phase === 'done') {
            return (
                <div style={{position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif'}}>
                    <div style={Object.assign({}, card, {width: 'min(520px, 92vw)'})}>
                        <div style={{fontWeight: 700, fontSize: '15px', marginBottom: '10px'}}>{'Your recording'}</div>
                        <video
                            src={videoUrl}
                            controls
                            style={{width: '100%', borderRadius: '10px', background: '#000', maxHeight: '60vh'}}
                        />
                        <div style={{display: 'flex', gap: '8px', marginTop: '12px'}}>
                            <button type="button" style={btn(PINE)} onClick={this.download}>{'Download video'}</button>
                            <button type="button" style={btn(CLAY)} onClick={this.reset}>{'Record again'}</button>
                            <button type="button" style={btn('#efe9e0', {color: INK, marginLeft: 'auto'})} onClick={this.reset}>{'Close'}</button>
                        </div>
                    </div>
                </div>
            );
        }

        // idle
        return (
            <div style={anchor}>
                {error ? (
                    <div style={{marginBottom: '8px', background: '#fee4e2', color: '#912018', border: '1px solid #fda29b', borderRadius: '10px', padding: '6px 10px', font: '600 12px system-ui', width: '220px'}}>
                        {error}
                    </div>
                ) : null}
                <button
                    type="button"
                    onClick={this.openSetup}
                    style={btn('#fff', {color: INK, border: `1px solid ${LINE}`, boxShadow: '0 6px 18px rgba(36,31,26,.16)', display: 'inline-flex', alignItems: 'center', gap: '8px'})}
                >
                    <span style={{width: '10px', height: '10px', borderRadius: '50%', background: REC_RED}} />
                    {'Record video'}
                </button>
            </div>
        );
    }
}

KatRecorder.propTypes = {
    vm: PropTypes.object
};

const mapStateToProps = state => ({
    vm: state.scratchGui.vm
});

export default connect(mapStateToProps)(KatRecorder);
