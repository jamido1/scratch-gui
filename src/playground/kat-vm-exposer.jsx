import PropTypes from 'prop-types';
import {Component} from 'react';
import {connect} from 'react-redux';

/*
 * KAT bridge helper: the scratch-vm instance lives in the Redux store (state.scratchGui.vm), so this
 * tiny connected component copies it onto window.__katVM where scripts/playground/bridge.js can reach it.
 * It renders nothing. Mounted inside the GUI's AppStateHOC Provider (see render-gui.jsx).
 */
class KatVmExposer extends Component {
    componentDidMount () {
        window.__katVM = this.props.vm;
    }
    componentDidUpdate () {
        window.__katVM = this.props.vm;
    }
    render () {
        return null;
    }
}

KatVmExposer.propTypes = {
    // eslint-disable-next-line react/forbid-prop-types
    vm: PropTypes.object
};

export default connect(state => ({vm: state.scratchGui.vm}))(KatVmExposer);
