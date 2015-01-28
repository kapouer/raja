module.exports = function(raja, socket) {
	return new RajaClient(raja, socket);
};

function RajaClient(raja, socket) {
	this.raja = raja;
	this.socket = socket;
}

RajaClient.prototype.init = function(cb) {
	var socket = this.socket;
	var raja = this.raja;
	var self = this;
	socket.emit('join', {room: '*'});
	socket.on('message', function(msg) {
		if (!msg.url) return;
		if (!msg.parents) msg.parents = [];
		raja.receive(msg);
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

