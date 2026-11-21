how to run: have python, do pip install flask and I think pip install requests, and then in the same folder where you have the file do 'flask -app scrapper run'
how to use: Run the thing, it will expose an API for you to use at port 5000. If you want it to use another port, edit the code to change it.
Then, querry it with the following request, for example:
http://127.0.0.1:5000/querry?username=nike&limit=5
The limit is the amount of recent posts you want to get (don't do more than like, 10 ig)
The username is the actual account you want to querry. I am doing it for nike, a professional account, but here are a few others you might want to use in 

the demo:
isamcgillu (indian student assoc)
mcgillmagicclub

returns:
ThumbnailURLs and mediaURLS will be especially useful as they can be directly downloaded
Caption is the title and stuff. 
Timestamp and ID as well
These can ALL be used by @LudioRex and @Okie 

NOTE: This is just a proof of concept, which @LudioRex I recommend you use to directly get posts from this for testing