from flask import Flask

app = Flask(__name__)

@app.get("/")
def home():
    return "<h1>Hello from Python (Flask)!</h1><p>/about for another page.</p>"

@app.get("/about")
def about():
    return "<h2>About</h2><p>This page is served by Flask.</p>"

if __name__ == "__main__":
    app.run(debug=True)
