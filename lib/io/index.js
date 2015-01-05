var socketioClient = require('socket.io-client');

module.exports = function(raja, opts, cb) {
	if (opts.server) {
		raja.server = require(__dirname + '/server')(opts);
	}
	raja.client = require(__dirname + '/client')(raja, socketioClient.connect(opts.uri));
	raja.client.init(cb);
};

