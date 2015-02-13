Session cookies - permissions - caching mecanism using Vary: X-Permission
=========================================================================

notes with examples

four sets of permissions: public, journalist, editor, admin
cookies are not only the sessionid, there could be other useless (for auth) cookies.

Example 1
---------

GET /assets
 Cookie: sessionid=112; gt=465

Auth middleware let journalist read /assets
 user from sessionid
 permissions from user (journalist)
 check permissions (journalist has one perm that is listed in the perms required to read assets)
 conclusion: auth middleware used only permission journalist to read that resource

200
 Vary:X-Permission
 X-Permission: journalist


Example 2
---------

GET /user/doe
 Cookie: sessionid=112; gt=465
 
Auth middleware let user doe read /user/doe
 user from sessionid
 permissions from user (doe)
 check permissions ok
 conclusion: auth used user itself to read that resource

200
 Vary: X-Permission
 X-Permission: doe


Example 3
---------

Using root with "admin" permissions (and possibly also editor, journalist, public,
depending on how they are declared in each allow() call for each resource)

GET /user/doe
 Cookie: sessionid=0; gt=465

Auth middleware let root read anything
 user from sessionid
 auth let user with admin permissions read any resource

200
 Vary: X-Permission
 X-Permission: admin


Example 4
---------

Likewise, we have as in example 2

GET /user/root
200
 Vary: X-Permission
 X-Permission: root

here we do not get
 X-Permission: admin

because of how the permissions to read /user/* are declared:

  app.route(/user/:name).get(
    allow(function() {
      if (req.params.name == req.session.name) return true;
    }, 'admin'), // in that order
    resources.users.GET
  )


Example 5
---------

Again - we should have the right cache hit

GET /user/doe
 Cookie: sessionid=0

Cache is able to get permissions from sessionid (here, admin) and looks up
the url and find two results
- /user/doe with permission doe
- /user/doe with permission admin

The first result is discarded because admin permission != doe permission,
ONE SHOULD NOT CONFUSE THE PERMISSION TO READ A RESOURCE WITH HOW PERMISSIONS
ARE MATCHED WHEN SEARCHING IN THE CACHE.


Example 6
---------

Suppose here a page itself is NOT checked for permissions, and it uses a mix
of resources.
The cache will store this information:

GET /some/page 200
 GET /some/page/list 200 X-Permission guest
 GET /user/doe 200 X-Permission doe

a) user access
auth will convert
Cookie: sessionid=112
to
X-Permission: doe, guest, journalist

cache will this that page url, and its resources, and check that X-Permission
is ok to access each resource (it does)

b) admin access
auth converts sessionid=0 to X-Permission: root, guest, journalist, admin

cache won't match /user/doe, perm doe and will be a miss.


Page permissions collation
--------------------------

In the above example,
/some/page should store X-Permission: guest, doe
directly - no need to check each resource each time.


Search cache
------------

It is the auth middleware that issued the Vary: X-Permission and the X-Permission HTTP Response Headers,
It is the auth middleware that re-creates from session Cookie X-Permission HTTP Request Headers

Cache.get(url, function(err, item) {
  item.vary[X-Permission] == ["guest", "doe"]
}


the cache should have an API to be able to search permissions using an index.
A unique key generated from url + vary fields is not useful, as the set of permissions
willing to find a hit can be larger than the list of permissions in the vary fields.

Basically, everything's all right as long as there is not too much entries
in the cache :() and that happens the moment a web site shows login info
on all its html pages and has many users.

How does Vary matching work ?

A request is presented to the cache with

url: url0
permissions: pa, pb, pc
accept-encoding: gzip, deflate // TODO check what happens with *

and the cache has these entries

0 url0
1 permissions=pa,pc url0
2 permissions=pa,pc&encoding=gzip url0
3 permissions=pa url0
4 permissions=pb,pc url0
5 permissions=pf,pg url0

The match is done by constructing several url and searching them in the cache.
Each constructed url is built out of a combination of the variable fields the
request has:
(omitting the permissions= start)
pa url0
pb url0
pc url0
pa,pb url0
pa,pc url0
pb,pc url0

the match with the most permissions is used - here it would be 1 or 4.
That conflict is resolved by choosing the most up-to-date entry.
In a correct application cache, it wouldn't happen: the same url0 cannot
depend on non-mutually-exclusive permissions:

pa,pb url0
pa,pc url0

can exist in the cache, in which case the application never grant permissions
pb AND pc to the same user.

This mecanism supports only (and obviously) very small permissions sets.
The smaller number of permissions required to view a page, the better.


Do not mis-evict entries from LFU
---------------------------------

It is not that bad though, because most of the time the entries of the users are
evicted very fast from the cache. To make sure it works, the cache should not
evict entries that have a hit score > 1, so that an entry cached for a user
does not replace an entry cached for many users:

Cache: (max 3)
url1   23
url2   23
url3   10

user read one page, put urlUser in the cache, evicting url3 - bad move !
in that case urlUser should just not go in the memory cache, only in the disk
cache - which can have good index support (even b-tree if permissions are stored in
separate table with n,n relation)


Other uses of Vary
------------------

Request: GET url + Accept-Encoding
Response: compressed body + Content-Encoding: gzip + Vary: Accept-Encoding.

