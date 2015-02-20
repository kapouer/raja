module.exports = function(raja, opts, cb) {
	if (opts.server) {
		raja.server = require(__dirname + '/server')(opts);
	}
	if (opts.client) {
		raja.client = require(__dirname + '/client')(raja, opts);
		raja.client.init(cb);
	} else {
		cb();
	}
};

