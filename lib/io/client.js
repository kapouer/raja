var io = require('socket.io-client');
var URL = require('url');
var debug = require('debug')('raja:io');

module.exports = function(raja, client, opts) {
	return new RajaClient(raja, client, opts);
};

function RajaClient(raja, client, opts) {
	this.raja = raja;
	this.pool = client.split(' ');
	this.namespace = opts.namespace;
	this.token = opts.token;
}

RajaClient.prototype.init = function(cb) {
	var self = this;
	var socket = this.socket = io(iouri());
	var raja = this.raja;
	var timeout;
	socket.on('message', function(msg) {
		raja.receive(msg);
	});
	socket.on('connect', function() {
		socket.emit('join', {room: '*'});
		if (cb) {
			cb(null, self);
			cb = null;
		}
	});
	socket.on('error', raja.error);
	socket.on('connect_error', function(e) {
		console.error(e || "connect_error", socket.io.uri);
		socket.io.uri = iouri();
	});

	function iouri() {
		var iopath = '/' + self.namespace + '?token=' + encodeURIComponent(self.token);
		var iohost = randomEl(self.pool);
		// if a url without protocol was given, always default to https
		if (!URL.parse(iohost).protocol) iohost = "https:" + iohost;
		return iohost + iopath;
	}
};

RajaClient.prototype.send = function(msg) {
	debug('emit', msg);
	this.socket.emit('message', msg);
};

function randomEl(arr) {
	var index = parseInt(Math.random() * arr.length);
	return arr[index];
}

