module.exports = function(raja, session) {
	var Store = session.Store;

	function RajaSessionStore(opts) {
		this.opts = opts || {};
		this.maxage = opts.maxage || 3600 * 24; // defaults to one-day session
		Store.call(this, opts);
		prune.call(this);
	}

	require('util').inherits(RajaSessionStore, Store);

	RajaSessionStore.prototype.get = function(sid, cb) {
		var key = getKey(sid);
		raja.store.get(key, function(err, resource) {
			if (err || !resource) return cb(err);
			cb(null, JSON.parse(resource.data.toString()));
		});
	};

	RajaSessionStore.prototype.set = function(sid, session, cb) {
		var key = getKey(sid);
		raja.store.get(key, function(err, resource) {
			if (err) return cb(err);
			if (!resource) resource = { key: key, builder: 'session' };

			resource.mtime = new Date();
			resource.maxage = session.cookie && session.cookie.maxAge / 1000 || this.maxage;
			resource.data = JSON.stringify(session);
			raja.store.set(key, resource);
			cb();
		}.bind(this));
	};

	RajaSessionStore.prototype.destroy = function(sid, cb) {
		raja.store.del(getKey(sid), cb);
	};

	function prune() {
		setTimeout(function() {
			raja.store.expire('session', function(err) {
				setImmediate(prune.call(this));
			}.bind(this));
		}.bind(this), 10 * 60 * 1000);
	}

	function getKey(sid) {
		return 'sid:' + sid;
	}

	return RajaSessionStore;
};
