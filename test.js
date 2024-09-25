
const express = require('express');
const { json } = require('body-parser');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(json());

app.listen(PORT, async () => {
  console.log(`Firing up on port ${PORT}...`);
});

app.post('/', async (req, res) => {  
  console.log("TESTER TESTING");
  res.status(200).send('Received');
});

