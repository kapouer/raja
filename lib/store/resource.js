var Model = require('objection').Model;

function Resource() {
	Model.apply(this, arguments);
}

module.exports = Model.extend(Resource);

Resource.tableName = 'raja_resources';
Resource.jsonSchema = {
	type: 'object',
	properties: {
		id: { type: 'integer' },
		key: { type: 'string'	},
		url: { type: 'string'	},
		mtime: { type: 'string', format: 'date-time' },
		maxage: { type: 'integer' },
		headers: { type: 'object' },
		valid: { type: 'boolean', default: true },
		data: { type: 'object' },
		code: { type: 'integer', default: 200 },
		builder: { type: 'string' }
	},
	required: ['key']
};

Resource.relationMappings = {
	children: {
		relation: Model.ManyToManyRelation,
		modelClass: Resource,
		join: {
			from: 'raja_resources.id',
			through: {
				from: 'raja_relations.parent_id',
				to: 'raja_relations.child_id'
			},
			to: 'raja_resources.id'
		},
		filter: function(query) {
			query.orderBy('order');
		}
	},
	parents: {
		relation: Model.ManyToManyRelation,
		modelClass: Resource,
		join: {
			from: 'raja_resources.id',
			through: {
				from: 'raja_relations.child_id',
				to: 'raja_relations.parent_id'
			},
			to: 'raja_resources.id'
		},
		filter: function(query) {
			query.orderBy('order');
		}
	}
};

Resource.prototype.$beforeValidate = function(schema, json, opts) {
	var copy = {};
	for (var key in schema.properties) {
		if (json[key] !== undefined) copy[key] = json[key];
	}
	return copy;
};

Resource.prototype.beforeSave = function() {
	if (this.data != null) {
		if (this.valid == null) {
			this.valid = true;
		}
	} else if (this.valid != null) {
		this.valid = false;
	}
	if (!this.headers) this.headers = {};
	this.mtime = new Date().toISOString();
};

Resource.prototype.$parseDatabaseJson = function(json) {
	var data = json.data;
	delete json.data;
	json = Model.prototype.$parseDatabaseJson.call(this, json);
	json.data = data;
	return json;
};

Resource.prototype.$formatDatabaseJson = function(json) {
	var data = json.data;
	delete json.data;
	json = Model.prototype.$formatDatabaseJson.call(this, json);
	if (data == null) {
		json.data = null;
	} else if (Buffer.isBuffer(data)) {
		json.data = data;
	} else if (typeof data != "string") {
		json.data = JSON.stringify(data);
	} else {
		json.data = data;
	}
	return json;
};

