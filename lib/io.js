/*
 * raja instance
 * opts: uri (of the io namespace), server: port number or HTTPServer,
 *       other options are documented socket.io server options
 * cb callback(err, socket) when io is connected
 */
module.exports = function(raja, opts, cb) {
	if (opts.server) {
		raja.server = new RajaServer(opts);
	}
	raja.client = new RajaClient(raja, require('socket.io-client').connect(opts.uri));
	raja.client.init(cb);
};

function RajaClient(raja, socket) {
	this.raja = raja;
	this.socket = socket;
}
require('util').inherits(RajaClient, require('events').EventEmitter);

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

function RajaServer(opts) {
	var server = opts.server && opts.server.listen ? opts.server : require('url').parse(opts.uri).port;
	delete opts.server; // do not keep a reference - it could be HTTPServer object
	var io = require('socket.io')(server, opts);
	io.on('connection', function(socket) {
		socket.on('message', function(msg) {
			if (!msg.url) return console.info("Messages are expected to have a url field", msg);
			io.to('*').to(msg.url).emit('message', msg);
		});
		socket.on('join', function(msg) {
			socket.join(msg.room, function(err) {
				if (err) console.error(err)
			});
		});
	});
}

