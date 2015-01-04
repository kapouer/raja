/*
 * raja instance
 * uri of the io namespace - not of a room
 * cb callback(err, socket) when io is connected
 */
module.exports = function(raja, uri, cb) {
	var server = raja.opts.server;
	if (server) {
		raja.server = new RajaServer(uri, server);
	}
	raja.client = new RajaClient(raja, require('socket.io-client').connect(uri));
	raja.client.init(cb);
};

function RajaClient(raja, socket) {
	this.raja = raja;
	this.socket = socket;
}
require('util').inherits(RajaClient, require('events').EventEmitter);

RajaClient.prototype.init = function(cb) {
	var socket = this.socket;
	var raja = this.raja;
	var self = this;
	socket.emit('join', {room: '*'});
	socket.on('message', function(msg) {
		raja.receive(msg);
		self.emit('message', msg);
	});
	socket.on('connect', function() {
		cb(null, self);
	});
	socket.on('connect_error', function(err) {
		cb(err);
	});
	socket.on('error', function(err) {
		raja.error(err);
	});
};

RajaClient.prototype.send = function(msg) {
	this.socket.emit('message', msg);
};

function RajaServer(uri, server) {
	if (!server.listen) server = require('url').parse(uri).port;
	var io = require('socket.io')(server);
	io.on('connection', function(socket) {
		socket.on('message', function(msg) {
			if (!msg.url) return;
			io.to('*').to(msg.url).emit('message', msg);
		});
		socket.on('join', function(msg) {
			socket.join(msg.room, function(err) {
				if (err) console.error(err)
			});
		});
	});
}

