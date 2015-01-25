var socketio = require('socket.io');
var URL = require('url');
var backlog = require("socket.io-backlog");

module.exports = function(opts) {
	return new RajaServer(opts);
};

function RajaServer(opts) {
	var io = socketio(opts.server, opts);
	io.adapter(backlog(opts));
	var nsp = opts.namespace ? io.of(opts.namespace) : io;
	nsp.on('connection', function(socket) {
		socket.on('message', function(msg) {
			if (!msg.url) return;
			if (!msg.parents) msg.parents = [];
			var room = msg.parents.slice(-1).pop() || msg.url;
			nsp.to('*').to(room).emit('message', msg);
		});
	});
}

