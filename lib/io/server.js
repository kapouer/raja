var socketio = require('socket.io');
var URL = require('url');
var backlog = require("socket.io-backlog");

module.exports = function(server, opts) {
	return new RajaServer(server, opts);
};

function RajaServer(server, opts) {
	var io = socketio(server, opts);
	io.adapter(backlog(opts));
	var nsp = opts.namespace ? io.of(opts.namespace) : io;
	nsp.on('connection', function(socket) {
		socket.on('join', function(data) {
			socket.join(data.room, data.mtime);
		});
		socket.on('leave', function(data) {
			socket.leave(data.room);
		});
		socket.on('message', function(msg) {
			if (!msg.key && !msg.url) return;
			if (!msg.parents) msg.parents = [];
			var room = msg.parents.slice(-1).pop() || msg.key || msg.url;
			nsp.to('*').to(room).emit('message', msg);
		});
	});
}

