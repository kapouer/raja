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
			var room = msg.room || msg.url;
			if (!room) return console.info("Messages are expected to have a room or url", msg);
			io.to('*').to(room).emit('message', msg);
		});
	});
}

