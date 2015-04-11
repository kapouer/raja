module.exports = function(raja, opts, cb) {
	if (opts.server) {
		var server = opts.server;
		delete opts.server;
		raja.server = require(__dirname + '/server')(server, opts);
	}
	if (opts.client) {
		var client = opts.client;
		delete opts.client;
		raja.client = require(__dirname + '/client')(raja, client, opts);
		raja.client.init(cb);
	} else {
		cb();
	}
};

