Resources HTTP API
==================

Notations
---------

```
METHOD url
request body
<response code> response body, ...
```

"obj" represents a javascript object {}

"list" represents a javascript list []

Status codes
------------

```
200 OK           a response with body
204 No Content   without body
207 Multi-Status some resources are {status: <notok>, message: "error message"}
400 Bad Request  bad request parameters or bad body
404 Not Found    resource does not exists
```

Semantics of PUT and DELETE are modified to make it easier and cheaper
to change multiple elements in a collection.

Semantics
---------

PUT is used differently than in standard REST semantics - here it means
"update" more than "replace", meaning the request body updates only what it
defines.

So on an element, PUT {id: 1, title: "two"} updates

`{title: "test", body: "a body"}`

to be

`{title: "two", body: "a body"}`.

Likewise, on a collection, PUT [obj1, obj2] is going to update the elements
obj1 and obj2 of the collection, not replace the whole collection.

DELETE can accept a list to delete from a collection, without having
to delete the whole collection.


Elements
--------

GET /element  
200 obj, 400, 404

PUT /element  
obj  
200 Obj, 204, 400, 404

DELETE /element  
204, 400, 404


Collections
-----------

The methods using lists are introduced as the general case.
Individual elements can be acted upon with GET, PUT, DELETE when they are
not seen as part of a collection.

GET /collection  
200 list, 400, 404

POST /collection  
list  
200 list, 207 list, 400, 404

If one of the multiple resources had a status code different that 200,
207 is used and "status" property must be set on the elements having that
different status code (further data could go in a "message" property), like this

```
POST [{text: "text1"}, {stuff: "text2"}]
207 [{id:1, text: "text1"}, {status: 400, message: "text must not be empty"}]
```

PUT /collection  
list of elements with unique identifiers  
200 list, 207 list, 400, 404  
See semantics of PUT in the introduction above.

DELETE /collection  
list of elements with unique identifiers  
204, 207 list, 400, 404  
See semantics of DELETE in the introduction above.


Resources transformations messages
==================================

The goal is to be able to present resources and modifications of resources
in a homogeneous format.

Elements
--------

GET /element  
{method: GET, url: /element, data: obj}

PUT /element  
{method: PUT, url: /element, data: obj}  
obj is the element after modification.

DELETE /element  
{method: DELETE, url: /element}  
As can be seen on the message, it is not homogeneous (missing data).  
It is actually a mistake to DELETE an element when it is not part of a
collection. When this case happens, the corresponding collection message is
emitted instead.


Collections
-----------

GET /collection  
{method: GET, url: /collection, data: list}

POST /collection  
{method: POST, url: /collection, data: list}  
list is the list of elements after their creation.

PUT /collection  
{method: PUT, url: /collection, data: list}  
each element in the list contains its unique identifier

DELETE /collection  
{method: DELETE, url: /collection, data: list}  
each element in the list contains its unique identifier (and possibly only that)


In conclusion, note that

* DELETE /list/element  
  is represented by a message to the parent list.
* PUT /list/element  
  is represented by two messages, one to the element and one to the parent list.

