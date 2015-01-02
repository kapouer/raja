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
	var socket = require('socket.io-client').connect(uri);
	socket.on('message', function(msg) {
		raja.receive(msg);
	});
	socket.on('connect', function() {
		cb(null, socket);
	});
	socket.on('connect_error', function(err) {
		cb(err);
	});
	socket.on('error', function(err) {
		raja.error(err);
	});
};

function RajaServer(uri, server) {
	if (!server.listen) server = require('url').parse(uri).port;
	var io = require('socket.io')(server);
	io.on('connection', function(socket){
		console.log('a user connected', socket.request._query);
	});
}

