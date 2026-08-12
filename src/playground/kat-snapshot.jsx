import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';

/*
 * KAT stage snapshot (self-hosted scratch-gui addition, not upstream).
 *
 * A compact camera button in the stage controls row that downloads a PNG STILL of the stage (a
 * screenshot of the project as it looks right now). Purely local, like the recorder's own Download: it
 * reads the VM from the store and calls vm.renderer.requestSnapshot (scratch-render's own stage capture,
 * which forces a fresh draw+read, so it dodges the blank-frame WebGL quirk a raw canvas.toDataURL can
 * hit), then downloads the image. No parent, no presigned URL, no R2, so it works in the standalone
 * editor too. Reads the VM from the store like KatVmExposer/KatRecorder, so it touches no vendored
 * scratch-gui logic and survives upstream merges.
 */

const LINE = '#e7ded2';
const INK = '#241f1a';
const PINE = '#2f6f4e';

const pad2 = n => (n < 10 ? '0' : '') + n;
const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
        `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
};

class KatSnapshot extends React.Component {
    constructor (props) {
        super(props);
        this.state = {saved: false};
        this._timer = null;
        this.handleTake = this.handleTake.bind(this);
    }
    componentWillUnmount () {
        if (this._timer) clearTimeout(this._timer);
    }
    handleTake () {
        const renderer = this.props.vm && this.props.vm.renderer;
        if (!renderer || typeof renderer.requestSnapshot !== 'function') return;
        renderer.requestSnapshot(dataUri => {
            try {
                const a = document.createElement('a');
                a.href = dataUri;
                a.download = `scratch-stage-${stamp()}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                // Brief tick of feedback so the pupil knows it worked (the file lands in Downloads).
                this.setState({saved: true});
                if (this._timer) clearTimeout(this._timer);
                this._timer = setTimeout(() => this.setState({saved: false}), 1200);
            } catch (e) {
                /* download blocked by the browser; nothing else we can do here */
            }
        });
    }
    render () {
        // Only when a VM with a renderer exists, so a build without the stage never shows a dead button.
        if (!(this.props.vm && this.props.vm.renderer)) return null;
        const saved = this.state.saved;
        const btn = {
            width: '34px',
            height: '34px',
            borderRadius: '50%',
            border: `1px solid ${saved ? PINE : LINE}`,
            background: '#fff',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            marginLeft: '8px',
            verticalAlign: 'middle'
        };
        return (
            <button
                type="button"
                title="Download a picture of the stage"
                aria-label="Download a picture of the stage"
                onClick={this.handleTake}
                style={btn}
            >
                {saved ? (
                    <svg
                        width="17"
                        height="17"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={PINE}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M20 6 9 17l-5-5" />
                    </svg>
                ) : (
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={INK}
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                        <circle
                            cx="12"
                            cy="13"
                            r="4"
                        />
                    </svg>
                )}
            </button>
        );
    }
}

KatSnapshot.propTypes = {
    vm: PropTypes.object
};

const mapStateToProps = state => ({
    vm: state.scratchGui.vm
});

export default connect(mapStateToProps)(KatSnapshot);
