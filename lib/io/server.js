var socketio = require('socket.io');
var URL = require('url');
var backlog = require("socket.io-backlog");

module.exports = function(opts) {
	return new RajaServer(opts);
};

function RajaServer(opts) {
	var server = opts.server && opts.server.listen ? opts.server : URL.parse(opts.uri).port;
	delete opts.server; // do not keep a reference - it could be HTTPServer object
	var io = socketio(server, opts);
	io.adapter(backlog(opts));
	io.on('connection', function(socket) {
		socket.on('message', function(msg) {
			if (!msg.url) return;
			if (!msg.parents) msg.parents = [];
			var room = msg.parents.slice(-1).pop() || msg.url;
			io.to('*').to(room).emit('message', msg);
		});
	});
}

