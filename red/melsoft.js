//@ts-check
try {
    var Melsoft = require("@protocols/node-melsoft");
}catch (error){
    var Melsoft = null;
}

const MIN_CYCLE_TIME = 100;

module.exports = function (RED) {


    function generateStatus(status, val) {
        var obj;
        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._('melsoft.endpoint.status.online');
        }
        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._('melsoft.endpoint.status.offline')
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._('melsoft.endpoint.status.connecting')
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._('melsoft.endpoint.status.unknown')
                };
        }
        return obj;
    }

    function createTranslationTable(vars) {
        var res = {};

        vars.forEach(function (elm) {
            if (!elm.name || !elm.addr) {
                //skip incomplete entries
                return;
            }
            
            res[elm.name] = elm.addr;
        });

        return res;
    }

    function equals(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return false;
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length != b.length) return false;
    
            for (var i = 0; i < a.length; ++i) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        return false;
    }

    function nrInputShim(node, fn) {
        node.on('input', function (msg, send, done) {
            send = send || node.send;
            done = done || (err => err && node.error(err, msg));
            fn(msg, send, done);
        });
    }

    // <Begin> --- Endpoint ---
    function MelsoftEndpoint(config) {
        let oldValues = {};
        let readInProgress = false;
        let readDeferred = 0;
        let currentCycleTime = config.cycletime;
        let address = config.address
        let port = config.port
        let timeout = config.timeout
        let _cycleInterval;
        let _reconnectTimeout = null;
        let connected = false;
        let status;
        let that = this;
        let melsoftEndpoint = null
        let addressGroup = null;
        let module = config.module;
        
        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of melsoft In nodes
        this.setMaxListeners(0);

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            that.emit('__STATUS__', status);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                readInProgress = true;
                
                addressGroup.readAllItems()
                .then(result => {
                    cycleCallback(result);
                })
                .catch(error => {
                    onError(error);
                    readInProgress = false;
                });

            } else {
                readDeferred++;
            }
        }

        function cycleCallback(values) {
            readInProgress = false;

            if (readDeferred && connected) {
                doCycle();
                readDeferred = 0;
            }

            manageStatus('online');

            var changed = false;
            that.emit('__ALL__', values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    that.emit(key, values[key]);
                    that.emit('__CHANGED__', {
                        key: key,
                        value: values[key]
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) that.emit('__ALL_CHANGED__', values);
        }

        function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                that.error(RED._("melsoft.endpoint.error.invalidtimeinterval", { interval: interval }));
                return false
            }

            clearInterval(_cycleInterval);

            // don't set a new timer if value is zero
            if (!time) return false;

            if (time < MIN_CYCLE_TIME) {
                that.warn(RED._("melsoft.endpoint.info.cycletimetooshort", { min: MIN_CYCLE_TIME }));
                time = MIN_CYCLE_TIME;
            } 

            currentCycleTime = time;
            _cycleInterval = setInterval(doCycle, time);

            return true;
        }

        function removeListeners() {
            if (melsoftEndpoint !== null) {
                melsoftEndpoint.removeListener('connected', onConnect);
                melsoftEndpoint.removeListener('disconnected', onDisconnect);
                melsoftEndpoint.removeListener('error', onError);
                melsoftEndpoint.removeListener('timeout', onTimeout);
            }
        }

        /**
         * Destroys the melsoft connection
         * @param {Boolean} [reconnect=true]  
         * @returns {Promise}
         */
        async function disconnect(reconnect = true) {
            // if (!connected) return;
            connected = false;

            clearInterval(_cycleInterval);
            _cycleInterval = null;

            if (melsoftEndpoint) {
                if (!reconnect) melsoftEndpoint.removeListener('disconnected', onDisconnect);
                melsoftEndpoint.destroy()
                melsoftEndpoint = null;
            }

            console.log("Endpoint - disconnect");
        }

        
        async function connect() {
            
            if (!Melsoft) return that.error('Missing "@protocols/node-melsoft" dependency, avaliable only on the ST-One hardware. Please contact us at "st-one.io" for pricing and more information.')

            manageStatus('connecting');
            
            if (_reconnectTimeout !== null) {
                clearTimeout(_reconnectTimeout);
                _reconnectTimeout = null;
            }
            
            if (melsoftEndpoint !== null) {
                await disconnect();
            }
            
            melsoftEndpoint = new Melsoft.MelsoftEndpoint({address, port, timeout, module});
        
            melsoftEndpoint.on('connected', onConnect);
            melsoftEndpoint.on('disconnected', onDisconnect);
            melsoftEndpoint.on('error', onError);
            melsoftEndpoint.on('timeout', onTimeout);

            melsoftEndpoint.connect()
        }

        function onConnect() {
            readInProgress = false;
            readDeferred = 0;
            connected = true;

            addressGroup = new Melsoft.MelsoftItemGroup(melsoftEndpoint);

            manageStatus('online');

            let _vars = createTranslationTable(config.vartable);

            addressGroup.setTranslationCB(k => _vars[k]);
            let varKeys = Object.keys(_vars);

            if (!varKeys || !varKeys.length) {
                that.warn(RED._("melsoft.endpoint.info.novars"));
            } else {
                addressGroup.addItems(varKeys);
                updateCycleTime(currentCycleTime);
            }
        }

        function onDisconnect() {
            manageStatus('offline');
            if (!_reconnectTimeout) {
                _reconnectTimeout = setTimeout(connect, 4000);
            }
            removeListeners();
        }

        function onError(e) {
            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function onTimeout(e) {
            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function getStatus() {
            that.emit('__STATUS__', status);
        }

        function updateCycleEvent(obj) {
            obj.err = updateCycleTime(obj.msg.payload);
            that.emit('__UPDATE_CYCLE_RES__', obj);
        }

        manageStatus('offline');

        this.on('__DO_CYCLE__', doCycle);
        this.on('__UPDATE_CYCLE__', updateCycleEvent);
        this.on('__GET_STATUS__', getStatus);

        connect();

        this.on('close', done => {
            manageStatus('offline');
            clearInterval(_cycleInterval);
            clearTimeout(_reconnectTimeout);
            _cycleInterval = null
            _reconnectTimeout = null;
            
            that.removeListener('__DO_CYCLE__', doCycle);
            that.removeListener('__UPDATE_CYCLE__', updateCycleEvent);
            that.removeListener('__GET_STATUS__', getStatus);           

            disconnect(false)
            .then(done)
            .catch(err => onError(err))//TODO:

            console.log("Endpoint - on close!");
        });
        
    }

    RED.nodes.registerType('melsoft endpoint', MelsoftEndpoint);
    // <End> --- Endpoint ---

    // <Begin> --- Melsoft In
    function MelsoftIn(config) {
        RED.nodes.createNode(this, config);
        let statusVal;
        let that = this

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            that.error(RED._("melsoft.error.missingconfig"));
            return;
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            if (data instanceof Date) data = data.getTime();
            var msg = {
                payload: data,
                topic: key
            };
            statusVal = status !== undefined ? status : data;
            that.send(msg);
            endpoint.emit('__GET_STATUS__');
        }
        
        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function (key) {
                sendMsg(data[key], key, null);
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '');
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status, statusVal));
        }
        
        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.emit('__GET_STATUS__');

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    endpoint.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    endpoint.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL__', onData);
            }
        }

        this.on('close', function (done) {
            endpoint.removeListener('__ALL__', onDataSelect);
            endpoint.removeListener('__ALL__', onDataSplit);
            endpoint.removeListener('__ALL__', onData);
            endpoint.removeListener('__ALL_CHANGED__', onData);
            endpoint.removeListener('__CHANGED__', onChanged);
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener(config.variable, onData);
            done();
        });

    }

    RED.nodes.registerType('melsoft in', MelsoftIn);
    // <End> --- Melsoft In


    // <Begin> --- melsoft Control
    function MelsoftControl(config) {
        let that = this;
        RED.nodes.createNode(this, config);

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            this.error(RED._("melsoft.error.missingconfig"));
            return;
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status));
        }

        function onMessage(msg, send, done) {
            let func = config.function || msg.function;
            switch (func) {
                case 'cycletime':
                    endpoint.emit('__UPDATE_CYCLE__', {
                        msg: msg,
                        send: send,
                        done: done
                    });
                    break;
                case 'trigger':
                    endpoint.emit('__DO_CYCLE__');
                    send(msg);
                    done();
                    break;

                default:
                    this.error(RED._("melsoft.error.invalidcontrolfunction", { function: config.function }), msg);
            }
        }

        function onUpdateCycle(res) {
            let err = res.err;
            if (!err) {
                res.done(err);
            } else {
                res.send(res.msg);
                res.done();
            }
        }

        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.on('__UPDATE_CYCLE_RES__', onUpdateCycle);

        endpoint.emit('__GET_STATUS__');

        nrInputShim(this, onMessage);

        this.on('close', function (done) {
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener('__UPDATE_CYCLE_RES__', onUpdateCycle);
            done();
        });

    }
    RED.nodes.registerType("melsoft control", MelsoftControl);
    // <End> --- Melsoft Control

}