/* global Promise */
'use strict';

var extend = require('lodash.assign');
var filter = require('lodash.filter');

var util = require('util');
var request = require('request');

var WildEmitter = require('wildemitter');



function timeoutPromise(targetPromise, delay) {
    var timeoutRef;
    return Promise.race([
        targetPromise,
        new Promise(function (resolve, reject) {
            timeoutRef = setTimeout(function () {
                reject();
            }, delay);
        })
    ]).then(function (result) {
        clearTimeout(timeoutRef);
        return result;
    });
}

function delayPromise(delay) {
    return new Promise(function (resolve) {
        setTimeout(function () {
            resolve();
        }, delay);
    });
}

function makeRequest(opts) {
    return new Promise(function (resolve, reject) {
        request(opts, function (err, result, body) {
            if (err) {
                return reject(err);
            } else {
                return resolve([result, body]);
            }
        });
    });
}


function retryRequest(opts, timeout, allowedRetries) {
    return timeoutPromise(makeRequest(opts), (timeout || 20) * 1000).then(function (result) {
        var req = result[0], body = result[1];

        if (req.statusCode < 200 || req.statusCode >= 400) {
            throw new Error('HTTP Status Error' + req.statusCode);
        }
        return body;
    }).catch(function () {
        if (allowedRetries > 0) {
            return delayPromise(1000).then(function () {
                return retryRequest(opts, timeout, allowedRetries - 1);
            });
        } else {
            throw new Error('Dead Connection, exceeded retry limit');
        }
    });
}


function BOSHConnection(sm, stanzas) {
    var self = this;

    WildEmitter.call(this);

    self.sm = sm;

    self.stanzas = {
        BOSH: stanzas.getDefinition('body', 'http://jabber.org/protocol/httpbind'),
        StreamError: stanzas.getStreamError()
    };

    self.sendQueue = [];
    self.requests = [];
    self.maxRequests = 2;
    self.sid = '';

    self.on('raw:incoming', function (data) {
        data = data.trim();
        if (data === '') {
            return;
        }

        var bosh, err;

        try {
            bosh = stanzas.parse(data, self.stanzas.BOSH);
        } catch (e) {
            err = new self.stanzas.StreamError({
                condition: 'invalid-xml'
            });
            self.emit('stream:error', err, e);
            self.send(err);
            return self.disconnect();
        }

        if (!self.hasStream) {
            self.hasStream = true;
            self.stream = {
                id: bosh.sid,
                lang: bosh.lang || 'en',
                version: bosh.version || '1.0',
                to: bosh.to,
                from: bosh.from
            };
            self.sid = bosh.sid;
            self.maxRequests = bosh.requests;
        }

        var payload = bosh.payload;
        payload.forEach(function (stanzaObj) {
            if (!stanzaObj.lang) {
                stanzaObj.lang = self.stream.lang;
            }

            self.emit('stream:data', stanzaObj);
        });

        if (bosh.type === 'terminate') {
            self.rid = undefined;
            self.sid = undefined;
            self.emit('bosh:terminate', bosh);
            self.emit('stream:end');
            self.emit('disconnected', self);
        }
    });
}

util.inherits(BOSHConnection, WildEmitter);

BOSHConnection.prototype.connect = function (opts) {
    var self = this;

    self.config = extend({
        rid: Math.ceil(Math.random() * 9999999999),
        wait: 30,
        maxRetries: 5
    }, opts);

    self.hasStream = false;
    self.sm.started = false;
    self.url = opts.boshURL;

    self.sid = self.config.sid;
    self.rid = self.config.rid;

    self.requests = [];

    self.rid++;
    self.request(new self.stanzas.BOSH({
        version: self.config.version || '1.0',
        to: self.config.server,
        lang: self.config.lang || 'en',
        wait: self.config.wait,
        ver: '1.6',
        hold: 1
    }));
};

BOSHConnection.prototype.disconnect = function () {
    if (this.hasStream) {
        this.rid++;
        this.request(new this.stanzas.BOSH({
            type: 'terminate'
        }));
    } else {
        this.stream = undefined;
        this.sid = undefined;
        this.rid = undefined;
        this.emit('disconnected', this);
    }
};

BOSHConnection.prototype.restart = function () {
    var self = this;
    self.rid++;
    self.request(new self.stanzas.BOSH({
        to: self.config.server,
        lang: self.config.lang || 'en',
        restart: 'true'
    }));
};

BOSHConnection.prototype.send = function (data) {
    var self = this;
    if (self.hasStream) {
        self.sendQueue.push(data);
        process.nextTick(self.longPoll.bind(self));
    }
};

BOSHConnection.prototype.longPoll = function () {
    var canReceive = this.requests.length === 0;
    var canSend = this.sendQueue.length > 0 && this.requests.length < this.maxRequests;

    if (!this.sid || (!canReceive && !canSend)) {
        return;
    }

    var stanzas = this.sendQueue;
    this.sendQueue = [];
    this.rid++;

    this.request(new this.stanzas.BOSH({
        payload: stanzas
    }));
};

BOSHConnection.prototype.request = function (bosh) {
    var self = this;

    var ticket = {id: self.rid, request: null};
    bosh.rid = self.rid;
    bosh.sid = self.sid;

    var body = new Buffer(bosh.toString(), 'utf8').toString();

    self.emit('raw:outgoing', body);

    self.requests.push(ticket);

    var req = retryRequest({
        uri: self.url,
        body: body,
        method: 'POST',
        strictSSL: true
    }, self.config.wait * 1.5, this.config.maxRetries).catch(function (err) {
        self.hasStream = false;
        var serr = new self.stanzas.StreamError({
            condition: 'connection-timeout'
        });
        self.emit('stream:error', serr, err);
        self.disconnect();
    });

    ticket.request = req;

    req.then(function (body) {
        self.emit('raw:incoming', new Buffer(body, 'utf8').toString());
    });

    return req.then(function () {
        self.requests = filter(self.requests, function (item) {
            return item.id !== ticket.id;
        });
        if (bosh.type !== 'terminate') {
            // Delay next auto-request by two ticks since we're likely
            // to send data anyway next tick.
            process.nextTick(function () {
                process.nextTick(self.longPoll.bind(self));
            });
        }
    });
};

module.exports = BOSHConnection;
