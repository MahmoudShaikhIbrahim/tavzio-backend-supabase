const errorHandler = (err, req, res, next) => {
  console.error(err);

  // Postgres unique violation, surfaced by supabase-js as err.code '23505'
  if (err.code === '23505') {
    return res.status(409).json({ message: 'That value is already in use' });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    message: err.message || 'Server error',
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
};

const notFound = (req, res) => {
  res.status(404).json({ message: `Route not found: ${req.originalUrl}` });
};

module.exports = { errorHandler, notFound };
