var io = require('socket.io-client');
var URL = require('url');

module.exports = function(raja, opts) {
	return new RajaClient(raja, opts);
};

function RajaClient(raja, opts) {
	this.raja = raja;
	this.pool = opts.client.split(' ');
	this.namespace = opts.namespace;
	this.token = opts.token;
}

RajaClient.prototype.init = function(cb) {
	var iopath = '/' + this.namespace + '?token=' + encodeURIComponent(this.token);
	var iohost = randomEl(this.pool);
	// if a url without protocol was given, always default to https
	if (!URL.parse(iohost).protocol) iohost = "https:" + iohost;
	var socket = this.socket = io(iohost + iopath);
	var raja = this.raja;
	var self = this;
	socket.emit('join', {room: '*'});
	socket.on('message', function(msg) {
		raja.receive(msg);
	});
	socket.once('connect', function() {
		if (cb) cb(null, self);
	});
	socket.once('reconnect_failed', function(err) {
		if (err) raja.error(err);
		socket.removeAllListeners('message');
		socket.removeAllListeners('error');
		setImmediate(function() {
			self.init(raja.error);
		});
	});
	socket.on('error', raja.error);
};

RajaClient.prototype.send = function(msg) {
	this.socket.emit('message', msg);
};

function randomEl(arr) {
	var index = parseInt(Math.random() * arr.length);
	return arr[index];
}

