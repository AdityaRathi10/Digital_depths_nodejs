require('dotenv').config();
const express = require('express');
const expressLayouts = require('express-ejs-layouts');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Setup view engine and layout
app.use(expressLayouts);
app.set('layout', '_layout');
app.set('view engine', 'ejs');

app.get('/', (req, res) => {
  res.render('index', { title: 'Home' });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});