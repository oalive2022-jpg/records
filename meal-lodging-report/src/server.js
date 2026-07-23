require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const pool = require('./db');
const homeRoutes = require('./routes/home');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session' }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12時間
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

app.get('/', (req, res) => res.redirect('/login'));

app.use('/', homeRoutes);
app.use('/', adminRoutes);

app.use((req, res) => {
  res.status(404).send('ページが見つかりません');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
});
