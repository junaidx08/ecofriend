require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const https = require('https');
const path = require('path');
const { run, get, all, initDatabase } = require('./database');

/** Calendar YYYY-MM-DD in the server's local timezone */
function localCalendarDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function timestampToLocalCalendarDate(ts) {
  if (!ts) return null;
  return localCalendarDate(new Date(ts));
}

function isChallengeCompletedToday(completedAt) {
  if (!completedAt) return false;
  return timestampToLocalCalendarDate(completedAt) === localCalendarDate();
}

/** Whole calendar days between two YYYY-MM-DD strings (later − earlier). */
function calendarDaysBetween(earlierYmd, laterYmd) {
  const [y1, m1, d1] = earlierYmd.split('-').map(Number);
  const [y2, m2, d2] = laterYmd.split('-').map(Number);
  const a = new Date(y1, m1 - 1, d1);
  const b = new Date(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

/**
 * If the user missed at least one full day since last "all challenges" day, streak goes to 0.
 */
async function applyStreakMissedDays(userId, lastFullDay, todayYmd) {
  if (!lastFullDay) return;
  const gap = calendarDaysBetween(lastFullDay, todayYmd);
  if (gap >= 2) {
    await run('UPDATE users SET challenge_streak = 0 WHERE id = ?', [userId]);
  }
}

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'ecofriend_super_secret_2024';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.AI_MODEL || 'google/gemma-4-31b-it:free';

app.use(cors());
app.use(express.json());

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.userId = user.userId;
    next();
  });
};

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const existingUser = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await run(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword]
    );

    const token = jwt.sign({ userId: result.lastID }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: result.lastID,
        username,
        email,
        eco_score: 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Wrong password' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        eco_score: user.eco_score
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await get('SELECT id, username, email, eco_score, created_at FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/user/stats
app.get('/api/user/stats', authenticateToken, async (req, res) => {
  try {
    const user = await get(
      'SELECT id, username, email, eco_score, created_at FROM users WHERE id = ?',
      [req.userId]
    );

    const doneRows = await all(
      'SELECT completed_at FROM user_challenges WHERE user_id = ? AND completed = 1',
      [req.userId]
    );
    const completedToday = doneRows.filter((r) => isChallengeCompletedToday(r.completed_at)).length;

    const totalChallenges = await get(
      'SELECT COUNT(*) as count FROM challenges'
    );

    const carbonHistory = await all(
      'SELECT * FROM carbon_calculations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
      [req.userId]
    );

    const conversationCount = await get(
      'SELECT COUNT(*) as count FROM conversations WHERE user_id = ?',
      [req.userId]
    );

    res.json({
      user,
      completedChallenges: completedToday,
      totalChallenges: totalChallenges.count,
      carbonHistory,
      totalConversations: conversationCount.count,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/conversations
app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { topic, title } = req.body;
    console.log('Creating conversation for user:', req.userId, { topic, title });

    const result = await run(
      'INSERT INTO conversations (user_id, topic, title) VALUES (?, ?, ?)',
      [req.userId, topic || null, title || 'New Conversation']
    );

    console.log('Insert result:', result);
    res.json({ id: result.lastID, topic, title });
  } catch (error) {
    console.error('Conversation creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/conversations
app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const conversations = await all(
      'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC',
      [req.userId]
    );

    res.json({ conversations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/chat
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, conversation_id, topic } = req.body;

    // Save user message
    if (conversation_id) {
      await run(
        'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
        [conversation_id, 'user', message]
      );
    }

    // Fetch previous messages
    const previousMessages = await all(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [conversation_id]
    );

    // Build messages array for OpenRouter
    const messagesForAI = [
      {
        role: 'system',
        content: 'You are EcoFriend, a warm and knowledgeable AI assistant dedicated exclusively to environmental awareness. You only discuss topics related to nature, climate change, recycling, wildlife, oceans, energy, forests, and sustainability. If asked about anything unrelated to the environment, politely redirect the conversation back to eco topics. Keep responses informative, encouraging, and engaging.'
      },
      ...previousMessages.map(m => ({ role: m.role, content: m.content }))
    ];

    // Set up streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const requestData = JSON.stringify({
      model: MODEL,
      messages: messagesForAI,
      stream: true
    });

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Length': Buffer.byteLength(requestData)
      }
    };

    let fullResponse = '';

    const apiReq = https.request(options, (apiRes) => {
      let buffer = '';

      apiRes.on('data', async (chunk) => {
      console.log('RAW CHUNK FROM OPENROUTER:', chunk.toString());
      buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // Save the full AI response
              if (conversation_id && fullResponse) {
                await run(
                  'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
                  [conversation_id, 'assistant', fullResponse]
                );
              }
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullResponse += content;
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      });

      apiRes.on('end', async () => {
        if (conversation_id && fullResponse) {
          await run(
            'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
            [conversation_id, 'assistant', fullResponse]
          );
        }
        res.end();
      });
    });

    apiReq.on('error', (error) => {
      res.status(500).json({ error: error.message });
    });

    apiReq.write(requestData);
    apiReq.end();

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/messages/:conversationId
app.get('/api/messages/:conversationId', authenticateToken, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const messages = await all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [conversationId]
    );

    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/challenges
app.get('/api/challenges', authenticateToken, async (req, res) => {
  try {
    const challenges = await all('SELECT * FROM challenges');

    if (req.userId == null) {
      return res.json({
        challenges: challenges.map((c) => ({ ...c, completed: false })),
        streak: 0,
      });
    }

    const user = await get(
      'SELECT id, challenge_streak, challenge_last_full_day FROM users WHERE id = ?',
      [req.userId]
    );
    if (!user) {
      return res.json({
        challenges: challenges.map((c) => ({ ...c, completed: false })),
        streak: 0,
      });
    }

    const todayYmd = localCalendarDate();
    await applyStreakMissedDays(req.userId, user.challenge_last_full_day, todayYmd);

    const userFresh = await get(
      'SELECT challenge_streak, challenge_last_full_day FROM users WHERE id = ?',
      [req.userId]
    );

    const challengesWithStatus = await Promise.all(
      challenges.map(async (challenge) => {
        const row = await get(
          'SELECT completed, completed_at FROM user_challenges WHERE user_id = ? AND challenge_id = ?',
          [req.userId, challenge.id]
        );
        const completed =
          !!row && row.completed === 1 && isChallengeCompletedToday(row.completed_at);
        return { ...challenge, completed };
      })
    );

    res.json({
      challenges: challengesWithStatus,
      streak: userFresh.challenge_streak ?? 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/challenges/:id/complete
app.post('/api/challenges/:id/complete', authenticateToken, async (req, res) => {
  try {
    if (req.userId == null) {
      return res.status(401).json({ error: 'Sign in to complete challenges' });
    }

    const { id } = req.params;
    const todayYmd = localCalendarDate();

    const u0 = await get(
      'SELECT challenge_last_full_day FROM users WHERE id = ?',
      [req.userId]
    );
    await applyStreakMissedDays(req.userId, u0?.challenge_last_full_day, todayYmd);

    const existing = await get(
      'SELECT * FROM user_challenges WHERE user_id = ? AND challenge_id = ?',
      [req.userId, id]
    );

    if (existing && existing.completed === 1 && isChallengeCompletedToday(existing.completed_at)) {
      return res.status(400).json({ error: 'Challenge already completed today' });
    }

    const challenge = await get('SELECT points FROM challenges WHERE id = ?', [id]);
    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    if (existing) {
      await run(
        'UPDATE user_challenges SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND challenge_id = ?',
        [req.userId, id]
      );
    } else {
      await run(
        'INSERT INTO user_challenges (user_id, challenge_id, completed, completed_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)',
        [req.userId, id]
      );
    }

    await run(
      'UPDATE users SET eco_score = eco_score + ? WHERE id = ?',
      [challenge.points, req.userId]
    );

    const totalCh = (await get('SELECT COUNT(*) as n FROM challenges')).n;
    const doneRows = await all(
      'SELECT completed_at FROM user_challenges WHERE user_id = ? AND completed = 1',
      [req.userId]
    );
    const completedTodayCount = doneRows.filter((r) => isChallengeCompletedToday(r.completed_at)).length;

    if (completedTodayCount === totalCh && totalCh > 0) {
      const streakUser = await get(
        'SELECT challenge_streak, challenge_last_full_day FROM users WHERE id = ?',
        [req.userId]
      );
      const last = streakUser.challenge_last_full_day;
      if (last !== todayYmd) {
        let newStreak;
        if (!last) {
          newStreak = 1;
        } else if (calendarDaysBetween(last, todayYmd) === 1) {
          newStreak = (streakUser.challenge_streak ?? 0) + 1;
        } else {
          newStreak = 1;
        }
        await run(
          'UPDATE users SET challenge_streak = ?, challenge_last_full_day = ? WHERE id = ?',
          [newStreak, todayYmd, req.userId]
        );
      }
    }

    const user = await get(
      'SELECT eco_score, challenge_streak FROM users WHERE id = ?',
      [req.userId]
    );

    res.json({ eco_score: user.eco_score, streak: user.challenge_streak ?? 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/carbon
app.post('/api/carbon', authenticateToken, async (req, res) => {
  try {
    const { transport_score, diet_score, energy_score } = req.body;

    const total_score = (transport_score || 0) + (diet_score || 0) + (energy_score || 0);

    await run(
      'INSERT INTO carbon_calculations (user_id, transport_score, diet_score, energy_score, total_score) VALUES (?, ?, ?, ?, ?)',
      [req.userId, transport_score, diet_score, energy_score, total_score]
    );

    const suggestions = [
      { icon: '🚲', text: 'Switch one weekly car trip to cycling', impact: 'Save ~2kg CO₂ weekly' },
      { icon: '🥗', text: 'Try one meat-free day per week', impact: 'Save ~0.5kg CO₂ daily' },
      { icon: '💡', text: 'Switch to LED bulbs throughout your home', impact: 'Save ~200kg CO₂ yearly' }
    ];

    res.json({ total_score, suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/carbon
app.get('/api/carbon', authenticateToken, async (req, res) => {
  try {
    const calculations = await all(
      'SELECT * FROM carbon_calculations WHERE user_id = ? ORDER BY created_at DESC LIMIT 5',
      [req.userId]
    );

    res.json({ calculations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../dist')));

// For any route not matched by API, serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist', 'index.html'));
});

// Initialize database and start server
async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`EcoFriend backend running on port ${PORT}`);
  });
}

startServer();
