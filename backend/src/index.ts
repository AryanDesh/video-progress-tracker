import express from "express";
import cors from 'cors'
import dotenv from 'dotenv'
import { Pool } from 'pg';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'video_tracker',
  password: process.env.DB_PASSWORD || 'password',
  port: parseInt(process.env.DB_PORT || '5432'),
});

interface VideoProgress {
  video_id: string;
  user_id: string;
  checkpoints: boolean[];
  quizzes: { [key: string]: boolean };
  updated_at: Date;
}

interface ProgressRequest {
  checkpoints: boolean[];
  quizzes?: { [key: string]: boolean };
}

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS video_progress (
        video_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default_user',
        checkpoints BOOLEAN[] NOT NULL DEFAULT '{}',
        quizzes JSONB DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (video_id, user_id)
      );
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error);
  }
};


const validateCheckpoints = (checkpoints: boolean[], expectedLength?: number): boolean => {
  if (!Array.isArray(checkpoints)) return false;
  if (expectedLength && checkpoints.length !== expectedLength) return false;
  return checkpoints.every(checkpoint => typeof checkpoint === 'boolean');
};

const validateQuizzes = (quizzes: any): boolean => {
  if (!quizzes || typeof quizzes !== 'object') return true; // Optional field
  return Object.entries(quizzes).every(([key, value]) => 
    !isNaN(Number(key)) && typeof value === 'boolean'
  );
};

const mergeProgress = (
  existing: VideoProgress | null, 
  incoming: ProgressRequest
): { checkpoints: boolean[], quizzes: { [key: string]: boolean } } => {
  const existingCheckpoints = existing?.checkpoints || [];
  const existingQuizzes = existing?.quizzes || {};
  
  const mergedCheckpoints = incoming.checkpoints.map((newValue, index) => {
    const oldValue = existingCheckpoints[index] || false;
    return oldValue || newValue; // Once true, stays true
  });

  const mergedQuizzes = { ...existingQuizzes };
  if (incoming.quizzes) {
    Object.entries(incoming.quizzes).forEach(([key, value]) => {
      if (value && !mergedQuizzes[key]) {
        mergedQuizzes[key] = true;
      }
    });
  }
  
  return { checkpoints: mergedCheckpoints, quizzes: mergedQuizzes };
};

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Get video progress
app.get('/api/videos/:videoId/progress', async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.query.userId as string || 'default_user';
    
    if (!videoId) {
    res.status(400).json({ error: 'Video ID is required' });
      return 
    }
    
    const result = await pool.query(
      'SELECT * FROM video_progress WHERE video_id = $1 AND user_id = $2',
      [videoId, userId]
    );
    
    if (result.rows.length === 0) {
        res.json({ 
            checkpoints: [], 
            quizzes: {},
            message: 'No progress found - starting fresh'
        });
        return 
    }
    
    const progress = result.rows[0];
    res.json({
      checkpoints: progress.checkpoints,
      quizzes: progress.quizzes,
      updated_at: progress.updated_at
    });
    
  } catch (error) {
    console.error('Error fetching progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save video progress
app.post('/api/videos/:videoId/progress', async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.query.userId as string || 'default_user';
    const { checkpoints, quizzes }: ProgressRequest = req.body;
    
    // Validation
    if (!videoId) {
      res.status(400).json({ error: 'Video ID is required' });
      return
    }
    
    if (!validateCheckpoints(checkpoints)) {
        res.status(400).json({ error: 'Invalid checkpoints format' });
        return
    }
    
    if (!validateQuizzes(quizzes)) {
      res.status(400).json({ error: 'Invalid quizzes format' });
      return
    }
    
    // Additional validation - prevent checkpoint regression
    const existingResult = await pool.query(
      'SELECT * FROM video_progress WHERE video_id = $1 AND user_id = $2',
      [videoId, userId]
    );
    
    let existing: VideoProgress | null = null;
    if (existingResult.rows.length > 0) {
      existing = existingResult.rows[0];
      
      // Check for regression (true -> false transitions)
      const hasRegression = existing!.checkpoints.some((oldValue, index) => 
        oldValue && !checkpoints[index]
      );
      
      if (hasRegression) {
        res.status(400).json({ 
            error: 'Cannot uncomplete previously completed checkpoints' 
        });
        return 
      }
    }
    
    // Merge progress
    const merged = mergeProgress(existing, { checkpoints, quizzes });
    
    // Save to database
    const query = `
      INSERT INTO video_progress (video_id, user_id, checkpoints, quizzes, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (video_id, user_id)
      DO UPDATE SET 
        checkpoints = $3,
        quizzes = $4,
        updated_at = NOW()
      RETURNING *;
    `;
    
    const result = await pool.query(query, [
      videoId,
      userId,
      merged.checkpoints,
      JSON.stringify(merged.quizzes)
    ]);
    
    const savedProgress = result.rows[0];
    
    // Calculate completion statistics
    const totalCheckpoints = merged.checkpoints.length;
    const completedCheckpoints = merged.checkpoints.filter(Boolean).length;
    const completionRate = totalCheckpoints > 0 ? (completedCheckpoints / totalCheckpoints) : 0;
    const isCompleted = completionRate >= 0.8; // 80% threshold
    
    res.json({
      success: true,
      progress: {
        checkpoints: savedProgress.checkpoints,
        quizzes: savedProgress.quizzes,
        updated_at: savedProgress.updated_at
      },
      stats: {
        total_checkpoints: totalCheckpoints,
        completed_checkpoints: completedCheckpoints,
        completion_rate: Math.round(completionRate * 100),
        is_completed: isCompleted
      }
    });
    
  } catch (error) {
    console.error('Error saving progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all user progress (for dashboard)
app.get('/api/users/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM video_progress WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId || 'default_user']
    );
    
    const progressList = result.rows.map(row => {
      const totalCheckpoints = row.checkpoints.length;
      const completedCheckpoints = row.checkpoints.filter(Boolean).length;
      const completionRate = totalCheckpoints > 0 ? (completedCheckpoints / totalCheckpoints) : 0;
      
      return {
        video_id: row.video_id,
        checkpoints: row.checkpoints,
        quizzes: row.quizzes,
        updated_at: row.updated_at,
        stats: {
          total_checkpoints: totalCheckpoints,
          completed_checkpoints: completedCheckpoints,
          completion_rate: Math.round(completionRate * 100),
          is_completed: completionRate >= 0.8
        }
      };
    });
    
    res.json({ progress: progressList });
    
  } catch (error) {
    console.error('Error fetching user progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete progress (for testing/reset)
app.delete('/api/videos/:videoId/progress', async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.query.userId as string || 'default_user';
    
    await pool.query(
      'DELETE FROM video_progress WHERE video_id = $1 AND user_id = $2',
      [videoId, userId]
    );
    
    res.json({ success: true, message: 'Progress deleted successfully' });
    
  } catch (error) {
    console.error('Error deleting progress:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Analytics endpoint
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT video_id) as total_videos,
        COUNT(DISTINCT user_id) as total_users,
        COUNT(*) as total_sessions,
        AVG(array_length(checkpoints, 1)) as avg_checkpoints_per_video,
        AVG((SELECT COUNT(*) FROM unnest(checkpoints) as cp WHERE cp = true)) as avg_completed_checkpoints
      FROM video_progress
    `);
    
    const completionStats = await pool.query(`
      SELECT 
        video_id,
        COUNT(*) as total_attempts,
        SUM(CASE WHEN (SELECT COUNT(*) FROM unnest(checkpoints) as cp WHERE cp = true)::float / array_length(checkpoints, 1) >= 0.8 THEN 1 ELSE 0 END) as completions
      FROM video_progress 
      WHERE array_length(checkpoints, 1) > 0
      GROUP BY video_id
    `);
    
    res.json({
      overview: stats.rows[0],
      video_stats: completionStats.rows
    });
    
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((req, res, next) => {
  console.error('Unhandled error:');
  res.status(500).json({ error: 'Something went wrong!' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
const PORT = 3001;

const startServer = async () => {
  try {
    await initDB();
    
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🎥 Video progress API: http://localhost:${PORT}/api/videos/{id}/progress`);
      console.log(`📈 Analytics: http://localhost:${PORT}/api/analytics/overview`);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

startServer();