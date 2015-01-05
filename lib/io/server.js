var socketio = require('socket.io');
var URL = require('url');
var backlog = require("./adapter");

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
			if (!msg.url) return console.info("Messages are expected to have a url field", msg);
			io.to('*').to(msg.url).emit('message', msg);
		});
		socket.on('join', function(msg) {
			if (msg.mtime) socket.joinArgs = msg.mtime;
			socket.join(msg.room, function(err) {
				if (err) console.error(err)
			});
		});
	});
}

