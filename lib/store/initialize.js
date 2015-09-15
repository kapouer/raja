exports.up = function(knex) {
	return knex.schema.hasTable('raja_resources').then(function(exists) {
		if (exists) return;
		return knex.schema.createTable('raja_resources', function(t) {
			t.increments('id').primary();
			t.text('key').index();
			t.text('url');
			t.dateTime('mtime').index();
			t.integer('maxage');
			t.json('headers');
			t.boolean('valid');
			t.binary('data');
			t.integer('code');
			t.string('builder');
			t.string('test');
		});
	}).then(function() {
		return knex.schema.hasTable('raja_relations').then(function(exists) {
			if (exists) return;
			return knex.schema.createTable('raja_relations', function(t) {
				t.increments('id').primary();
				t.integer('parent_id').unsigned().references('raja_resources.id').index();
				t.integer('child_id').unsigned().references('raja_resources.id').index();
				t.integer('order').unsigned();
			});
		});
	});
};

exports.down = function(knex) {
	return knex.schema
		.dropTableIfExists('raja_relations')
		.dropTableIfExists('raja_resources');
};

