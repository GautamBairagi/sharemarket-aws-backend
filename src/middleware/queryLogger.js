/**
 * Query Logger Middleware
 *
 * Logs slow database queries (> 1 second) to console
 * Helps identify performance bottlenecks
 */

const SLOW_QUERY_THRESHOLD = 1000; // 1 second in milliseconds

/**
 * Wrap database pool to log slow queries
 * @param {Object} pool - MySQL pool instance
 * @returns {Object} Wrapped pool with logging
 */
const wrapPoolWithLogging = (pool) => {
    const originalExecute = pool.execute;

    // Override execute method to log queries
    pool.execute = function(sql, values) {
        const startTime = Date.now();

        return originalExecute.call(this, sql, values || [])
            .then((result) => {
                const duration = Date.now() - startTime;

                // Log slow queries
                if (duration > SLOW_QUERY_THRESHOLD) {
                    console.warn(`⏱️  [SLOW QUERY] ${duration}ms:`, {
                        sql: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
                        duration: `${duration}ms`,
                        timestamp: new Date().toISOString()
                    });
                }

                return result;
            })
            .catch((err) => {
                const duration = Date.now() - startTime;
                console.error(`❌ [QUERY ERROR] ${duration}ms:`, {
                    sql: sql.substring(0, 100),
                    error: err.message,
                    duration: `${duration}ms`,
                    timestamp: new Date().toISOString()
                });
                throw err;
            });
    };

    return pool;
};

module.exports = { wrapPoolWithLogging };
