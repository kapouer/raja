var orm = require('orm');
var queue = require('queue-async');
var Cache = require('adaptative-replacement-cache');
var CacheDebounce = require('cache-debounce');
var debug = require('debug')('raja:store');

module.exports = function(raja, opts, cb) {
	var store = new Store(raja, opts);
	orm.connect(opts.store, function(err, db) {
		if (err) return cb(err);
		store.init(db, cb);
	});
};

function Store(raja, opts) {
	this.reset = opts.reset || false;
	this.raja = raja;
	this.cache = new Cache(opts.cacheSize || 500);
	this.limbo = {};
	this.cache.on('eviction', function(key, resource) {
	}.bind(this));
}

Store.prototype.init = function(db, cb) {
	var SlowResource = this.SlowResource = db.define('SlowResource', {
		key: { type: 'text', index: true },
		url: { type: 'text' },
		mtime: { type: 'date', time: true, index: true },
		maxage: { type: 'integer' },
		headers: { type: 'object' }, // a hash
		valid: { type: 'boolean', defaultValue: true },
		data: { type: 'binary' },
		code: { type: 'integer', defaultValue: 200 },
		builder: { type: 'text' }
	}, {
		table: "raja_cached_resources",
		cache: false, // we cache better :)
		hooks: {
			beforeSave: beforeSaveResource
		},
	});

	SlowResource.hasMany("children", SlowResource, {order: {type: 'integer'}}, {
		reverse : "parents",
		key: true
	});

	var self = this;

	var q = queue(1);
	if (this.reset) {
		q.defer(SlowResource.drop);
	}
	q.defer(SlowResource.sync).awaitAll(function(err) {
		cb(err, self);
	});
};

Store.prototype.store = CacheDebounce(function(key, resource, cb) {
	var raja = this.raja;
	debug('store', key);
	this.SlowResource.one({key: key}, function(err, row) {
		if (err) return cb(err);
		if (!row) {
			debug('new SlowResource', key);
			row = new this.SlowResource();
		}
		if (resource.maxage == Infinity) resource.maxage = -1;
		row.save(resource, function(err) {
			if (err) return cb(err);
			saveRelations.call(this, row, resource.resources, cb);
		}.bind(this));
	}.bind(this));
}, function(key) {
	return key;
});

function beforeSaveResource() {
	if (this.data != null) {
		if (!Buffer.isBuffer(this.data)) {
			this.data = new Buffer(this.data.toString());
		}
		if (this.valid == null) {
			this.valid = true;
		}
	} else if (this.valid != null) {
		this.valid = false;
	}
	if (!this.headers) this.headers = {};
	this.mtime = new Date();
}

Store.prototype.get = function(key, cb) {
	debug('get', key);
	var resource = this.cache.get(key) || this.limbo[key];
	if (resource) {
		return cb(null, resource);
	}
	this.SlowResource.one({key: key}, function(err, row) {
		if (err || !row) return cb(err);
		var resource = this.raja.create(row);
		if (resource.maxage == -1) resource.maxage = Infinity;
		queue(2)
		.defer(getRelations, row, resource, true)
		.defer(getRelations, row, resource, false)
		.awaitAll(function(err) {
			if (err) return cb(err);
			this.cache.set(key, resource);
			cb(null, resource);
		}.bind(this));
	}.bind(this));
};

Store.prototype.del = function(key, cb) {
	debug('del', key);
	var cache = this.cache;
	var limbo = this.limbo;

	var resource = cache.get(key);
	if (resource) cache.del(key);
	else resource = limbo[key];
	delete limbo[key];

	if (resource) {
		resource.valid = false;
		if (resource.resources) for (var rkey in resource.resources) {
			var childResource = cache.get(rkey) || limbo[rkey];
			if (childResource && childResource.parents) {
				delete childResource.parents[key];
			}
		}
		if (resource.parents) for (var rkey in resource.parents) {
			var parentResource = cache.get(rkey) || limbo[rkey];
			if (parentResource && parentResource.resources) {
				delete parentResource.resources[key];
			}
		}
	}
	this.SlowResource.one({key: key}, function(err, row) {
		if (err || !row) return cb(err);
		queue(2)
		.defer(row.setParents.bind(row), [])
		.defer(row.setChildren.bind(row), [])
		.awaitAll(function(err) {
			row.remove(cb);
		});
	}.bind(this));
};

Store.prototype.invalidate = function(key, cb) {
	// what happens if it does not find any resource ?
	var resource = this.cache.get(key) || this.limbo[key];
	if (resource) {
		resource.valid = false;
		debug("invalidate cached", key);
		cb();
		cb = raja.error;
	}
	this.SlowResource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidate expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		debug("invalidate stored", key);
		rows[0].valid = false;
		rows[0].save(cb);
	});
};

Store.prototype.invalidateParents = function(msg, cb) {
	var raja = this.raja;
	var cache = this.cache;
	var limbo = this.limbo;
	var key = msg.parents.slice(-1).pop() || msg.key || msg.url;
	if (!key) return cb(new Error("Missing key in " + JSON.stringify(msg)));
	var resource = cache.get(key) || limbo[key];
	var parents = resource && resource.parents;
	var sentMsg = {};
	if (parents) for (var pkey in parents) {
		var parentResource = cache.get(pkey) || limbo[pkey];
		if (!parentResource) {
			continue;
		}
		parentResource.valid = false;
		var cmsg = raja.shallow(msg);
		cmsg.parents = msg.parents.slice();
		cmsg.parents.push(pkey);
		sentMsg[pkey] = true;
		raja.send(cmsg);
	} else {
		parents = {};
	}

	this.SlowResource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidateParents expects only one resource at " + key));
		else if (rows.length == 0) return cb();
		var res = rows[0];
		res.getParents(function(err, parents) {
			var q = queue(1);
			parents.forEach(function(par) {
				if (sentMsg[par.key]) return; // already dealt with
				var parentResource = cache.get(par.key) || limbo[par.key];
				if (parentResource) parentResource.valid = false;
				par.valid = false;
				q.defer(par.save.bind(par));
				var cmsg = raja.shallow(msg);
				cmsg.parents = msg.parents.slice();
				cmsg.parents.push(par.key);
				raja.send(cmsg);
			});
			q.awaitAll(function(err) {
				cb(err);
			});
		});
	});
};

Store.prototype.set = function(key, resource, cb) {
	debug('set', key);
	var raja = this.raja;
	cb = cb || raja.error;
	var cache = this.cache;
	var limbo = this.limbo;
	var store = this;
	var oldResource = cache.get(key) || limbo[key];
	// remove previous associations if we are going to update them
	if (oldResource && oldResource.resources && resource.resources) for (var rkey in oldResource.resources) {
		var childResource = cache.get(rkey) || limbo[rkey];
		if (childResource && childResource.parents) {
			delete childResource.parents[key];
		}
	}
	if (oldResource && oldResource.parents && resource.parents) for (var rkey in oldResource.parents) {
		var parentResource = cache.get(rkey) || limbo[rkey];
		if (parentResource && parentResource.resources) {
			delete parentResource.resources[key];
		}
	}
	// set new associations
	if (resource.resources) {
		Object.keys(resource.resources).forEach(function(rkey) {
			var resource = cache.get(rkey) || limbo[rkey];
			if (!resource) {
				debug('create child', rkey);
				resource = raja.create({key: rkey});
			}
			if (!resource.parents) {
				resource.parents = {};
			}
			// do not mess with whatever was put there
			if (!resource.parents[key]) {
				resource.parents[key] = true;
			}
		});
	}
	if (resource.parents) {
		Object.keys(resource.parents).forEach(function(rkey) {
			var resource = cache.get(rkey) || limbo[rkey];
			if (!resource) {
				debug('create parent', rkey);
				resource = raja.create({key: rkey});
			}
			if (!resource.resources) {
				resource.resources = {};
			}
			// do not mess with whatever was put there
			if (!resource.resources[key]) {
				resource.resources[key] = true;
			}
		});
	}
	beforeSaveResource.call(resource);
	cache.set(key, resource);
	limbo[key] = resource;
	this.store(key, resource, function(err) {
		delete limbo[key];
		debug('wrote', key);
		cb(err, resource);
	});
};

function saveRelations(inst, hash, cb) {
	if (!hash) return cb();
	var self = this;
	var SlowResource = this.SlowResource;
	var keys = Object.keys(hash);
	var order = 0, orders = {};
	keys.forEach(function(key, index) {
		orders[key] = index;
	});
	SlowResource.find({key: keys}, function(err, rows) {
		if (err) return cb(err);
		var notfound = self.raja.shallow(hash);
		rows.forEach(function(row) {
			delete notfound[row.key];
		});
		var q = queue(3);
		for (var rkey in notfound) {
			if ( self.limbo[rkey]) {
				debug('dependency being saved, skip declaring relation', rkey);
				continue;
			}
			q.defer(function(rkey, cb) {
				debug('save SlowResource', inst.key, "parent of", rkey);
				(new SlowResource({key: rkey})).save(cb);
			}, rkey);
		}
		q.awaitAll(function(err, savedRows) {
			var total = rows.concat(savedRows);
			setChildren(inst, total, orders, cb);
		});
	});
}

function setChildren(inst, rows, orders, cb) {
	inst.removeChildren(function(err) {
		if (err) return cb(err);
		var q = queue(1);
		rows.forEach(function(row) {
			q.defer(function(row, cb) {
				inst.addChildren(row, {order: orders[row.key]}, cb);
			}, row);
		});
		q.awaitAll(function(err) {
			cb(err);
		});
	});
}

function getRelations(row, resource, isChildren, cb) {
	var hash, method;
	if (isChildren) {
		hash = resource.resources = {};
		row.getChildren(next);
	} else {
		hash = resource.parents = {};
		row.getParents(next);
	}
	function next(err, rows) {
		if (err) return cb(err);
		if (isChildren) {
			rows.sort(function(ra, rb) {
				return ra.order < rb.order;
			});
		}
		rows.forEach(function(row) {
			hash[row.key] = true;
		});
		cb();
	}
}

