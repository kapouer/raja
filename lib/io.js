var io = require('socket.io-client');


/*
 * raja instance
 * uri of the io namespace - not of a room
 * cb callback(err, socket) when io is connected
 */
module.exports = function(raja, uri, cb) {
	var socket = io.connect(uri);
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

