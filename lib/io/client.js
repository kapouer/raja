var io = require('socket.io-client');
var URL = require('url');
var debug = require('debug')('raja:io');

module.exports = function(raja, client, opts) {
	return new RajaClient(raja, client, opts);
};

function RajaClient(raja, client, opts) {
	this.raja = raja;
	this.pool = client.split(' ').map(function(str) {
		str = str.trim();
		// if a url without protocol was given, always default to https
		if (str.substring(0, 2) == "//") str = "https:" + str;
		return URL.parse(str);
	});
	this.namespace = opts.namespace;
	this.token = opts.token;
}

RajaClient.prototype.init = function(cb) {
	var self = this;
	var socket = this.socket = io(iouri());
	var raja = this.raja;
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
	socket.on('reconnect_error', function(e) {
		console.error(e || "reconnect_error", socket.io.uri);
		socket.io.uri = iouri();
	});

	function iouri() {
		var iohost = randomEl(self.pool);
		iohost.pathname = self.namespace;
		iohost.query = {
			token: self.token
		};
		return URL.format(iohost);
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

