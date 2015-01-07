var events = require('events');
var util = require('util');

module.exports = function(raja, socket) {
	return new RajaClient(raja, socket);
};

function RajaClient(raja, socket) {
	this.raja = raja;
	this.socket = socket;
}
util.inherits(RajaClient, events.EventEmitter);

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

