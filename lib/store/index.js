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
	this.cache = new Cache(opts.cacheSize || 500);
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
		}
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
	debug('store', key);
	this.SlowResource.find({key: key}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("corrupted raja cache - duplicates of " + key));
		var row = rows.length && rows[0];
		if (!row) {
			debug('new SlowResource', key);
			row = new this.SlowResource();
			row.key = key;
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
		if (checkAge.call(this, resource, cb)) return;
		return setImmediate(function() {
			cb(null, resource);
		});
	}
	this.SlowResource.one({key: key}, function(err, row) {
		if (err || !row) return cb(err);
		var resource = this.raja.create(row);
		if (resource.maxage == -1) resource.maxage = Infinity;
		if (checkAge.call(this, resource, cb)) return;
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

function checkAge(resource, cb) {
	if (resource.mtime && resource.maxage > 0) {
		if (resource.mtime.getTime() + resource.maxage * 1000 < Date.now()) {
			// perempted resource
			// TODO honour Cache-Control: max-stale here but keep in mind the peremption also hits sessions
			// so Cache-Control must be granular to the resource
			this.del(resource.key, cb);
			return true;
		}
	}
}

Store.prototype.del = function(key, cb) {
	debug('del', key);
	var cache = this.cache;
	var limbo = this.limbo;

	var resource = cache.get(key);
	if (resource) cache.del(key);
	else resource = limbo[key];
	delete limbo[key];

	var rkey;
	if (resource) {
		resource.valid = false;
		if (resource.resources) for (rkey in resource.resources) {
			var childResource = cache.get(rkey) || limbo[rkey];
			if (childResource && childResource.parents) {
				delete childResource.parents[key];
			}
		}
		if (resource.parents) for (rkey in resource.parents) {
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
		cb = this.raja.error;
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
	var key = msg.parents.slice(-1).pop() || msg.key;
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
				var parentResource = cache.get(par.key) || limbo[par.key];
				if (parentResource) parentResource.valid = false;
				par.valid = false;
				q.defer(par.save.bind(par));
				if (sentMsg[par.key]) return; // already dealt with
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
	cb = cb || raja.error;
	var cache = this.cache;
	var limbo = this.limbo;
	var oldResource = cache.get(key) || limbo[key];
	// remove previous associations if we are going to update them
	var rkey;
	if (oldResource && oldResource.resources && resource.resources) for (rkey in oldResource.resources) {
		if (resource.resources[rkey]) continue;
		var childResource = cache.get(rkey) || limbo[rkey];
		if (childResource && childResource.parents) {
			debug("delete parent", key, "of child", rkey);
			delete childResource.parents[key];
		}
	}
	if (oldResource && oldResource.parents && resource.parents) for (rkey in oldResource.parents) {
		if (resource.parents[rkey]) continue;
		var parentResource = cache.get(rkey) || limbo[rkey];
		if (parentResource && parentResource.resources) {
			debug("delete child", key, "of parent", rkey);
			delete parentResource.resources[key];
		}
	}
	// set new associations
	if (resource.resources) {
		Object.keys(resource.resources).forEach(function(rkey) {
			var child = cache.get(rkey) || limbo[rkey];
			if (!child) {
				debug('create child', rkey);
				child = raja.create({key: rkey}, resource.resources[rkey]);
			}
			if (!child.parents) {
				child.parents = {};
			}
			// do not mess with whatever was put there
			if (!child.parents[key]) {
				child.parents[key] = true;
			}
		});
	}
	if (resource.parents) {
		Object.keys(resource.parents).forEach(function(rkey) {
			var parent = cache.get(rkey) || limbo[rkey];
			if (!parent) {
				debug('create parent', rkey);
				parent = raja.create({key: rkey}, resource.parents[rkey]);
			}
			if (!parent.resources) {
				parent.resources = {};
			}
			// do not mess with whatever was put there
			if (!parent.resources[key]) {
				parent.resources[key] = true;
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

Store.prototype.expire = function(builder, cb) {
	this.SlowResource.find({
		builder: builder,
		mtime: orm.lt(function() {
			return "now() - (maxage || ' seconds')::interval";
		})
	}).remove(cb);
};

function saveRelations(inst, hash, cb) {
	if (!hash) return cb(null, inst);
	var self = this;
	var keys = Object.keys(hash);
	var orders = {};
	keys.forEach(function(key, index) {
		orders[key] = index;
	});
	var q = queue();
	keys.forEach(function(key) {
		var obj = hash[key];
		if (obj === true) obj = {};
		q.defer(self.store.bind(self), key, obj);
	});
	q.awaitAll(function(err, relations) {
		setChildren(inst, relations, orders, cb);
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
			cb(err, inst);
		});
	});
}

function getRelations(row, resource, isChildren, cb) {
	var hash;
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
				return ra.order - rb.order;
			});
		}
		rows.forEach(function(row) {
			hash[row.key] = true;
		});
		cb();
	}
}

