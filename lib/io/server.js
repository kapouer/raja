var socketio = require('socket.io');
var URL = require('url');
var backlog = require("socket.io-backlog");
var debug = require('debug')('raja:io');

module.exports = function(server, opts) {
	return new RajaServer(server, opts);
};

function RajaServer(server, opts) {
	var token = opts.token;
	var io = socketio(server, opts);
	io.adapter(backlog(opts));
	var nsp = opts.namespace ? io.of(opts.namespace) : io;
	nsp.on('connection', function(socket) {
		socket.on('join', function(data) {
			debug('client socket joined', data.room, data.mtime);
			socket.join(data.room, data.mtime);
		});
		socket.on('leave', function(data) {
			socket.leave(data.room);
		});
		socket.on('message', function(msg) {
			if (!socket.request._query) {
				return console.error("_query object has disappeared");
			}
			if (token && socket.request._query.token != token) {
				return console.warn("Permission denied to write", msg);
			}
			if (!msg.key && !msg.url) {
				return console.warn("Message received without key", msg);
			}
			if (!msg.parents) msg.parents = [];
			var room = msg.parents.slice(-1).pop() || msg.key || msg.url;
			nsp.to('*').to(room).emit('message', msg);
		});
	});
}

