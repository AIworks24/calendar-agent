require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const axios = require('axios');
const moment = require('moment-timezone');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const config = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER
  },
  wordpress: {
    siteUrl: process.env.WP_SITE_URL,
    apiUser: process.env.WP_API_USER,
    apiPassword: process.env.WP_API_PASSWORD
  },
  timezone: 'America/New_York'
};

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey
});

// AI Event Parser
async function parseEventFromMessage(messageText, inputMethod) {
  const systemPrompt = `You are an AI assistant that extracts event information from natural language messages. 

Your task is to:
1. Extract event details (title, date, time, location, description)
2. Validate date-day combinations and flag/correct errors
3. Handle various input formats (casual text, formal emails, voice transcripts)
4. Return structured JSON data

CRITICAL DATE VALIDATION:
- Check if the day of week matches the date (e.g., "Monday, December 9" should be corrected if December 9 is actually a Tuesday)
- Use the current date as context: ${moment().tz(config.timezone).format('YYYY-MM-DD dddd')}
- If year is not specified, assume current year unless the date has passed, then assume next year
- If time is not specified, assume 7:00 PM for evening events, 10:00 AM for daytime events
- Always return dates in ISO format: YYYY-MM-DD
- Always return times in 24-hour format: HH:mm

Return ONLY a JSON object with this exact structure:
{
  "title": "Event name",
  "start_date": "YYYY-MM-DD",
  "start_time": "HH:mm:ss",
  "end_date": "YYYY-MM-DD",
  "end_time": "HH:mm:ss",
  "location": "Event location",
  "description": "Event description",
  "all_day": false,
  "validation_notes": "Any corrections made to dates/times",
  "confidence": "high|medium|low"
}

If critical information is missing, set confidence to "low" and include what's needed in validation_notes.`;

  const userPrompt = `Input Method: ${inputMethod}

Message:
${messageText}

Extract event details and return JSON.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: userPrompt
      }],
      system: systemPrompt
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }
    
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI parsing error:', error);
    throw error;
  }
}

// WordPress Events Calendar Integration
async function createWordPressEvent(eventData) {
  const wpEndpoint = `${config.wordpress.siteUrl}/wp-json/tribe/events/v1/events`;
  
  const eventPayload = {
    title: eventData.title,
    description: eventData.description || '',
    start_date: `${eventData.start_date} ${eventData.start_time}`,
    end_date: `${eventData.end_date} ${eventData.end_time}`,
    all_day: eventData.all_day || false,
    venue: {
      venue: eventData.location || 'TBD'
    },
    status: 'publish'
  };

  try {
    const response = await axios.post(wpEndpoint, eventPayload, {
      auth: {
        username: config.wordpress.apiUser,
        password: config.wordpress.apiPassword
      },
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return {
      success: true,
      eventId: response.data.id,
      eventUrl: response.data.url,
      data: response.data
    };
  } catch (error) {
    console.error('WordPress API error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

// SMS Handler (Twilio)
app.post('/api/sms', async (req, res) => {
  const messageBody = req.body.Body;
  const fromNumber = req.body.From;
  
  console.log(`Received SMS from ${fromNumber}: ${messageBody}`);

  try {
    const eventData = await parseEventFromMessage(messageBody, 'SMS');
    
    if (eventData.confidence === 'low') {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(`I need more information to create this event. Missing: ${eventData.validation_notes}`);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    const result = await createWordPressEvent(eventData);

    const twiml = new twilio.twiml.MessagingResponse();
    if (result.success) {
      let confirmMsg = `✅ Event created: ${eventData.title}\n📅 ${eventData.start_date} at ${eventData.start_time}`;
      if (eventData.validation_notes) {
        confirmMsg += `\n\n⚠️ Note: ${eventData.validation_notes}`;
      }
      confirmMsg += `\n\n🔗 ${result.eventUrl}`;
      twiml.message(confirmMsg);
    } else {
      twiml.message(`❌ Error creating event: ${result.error}`);
    }

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('SMS processing error:', error);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Sorry, there was an error processing your event. Please try again.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Voice Handler (Twilio)
app.post('/api/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  twiml.say('Please describe the event you want to create. Include the title, date, time, and location.');
  twiml.record({
    maxLength: 120,
    transcribe: true,
    transcribeCallback: '/api/voice/transcribe'
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/api/voice/transcribe', async (req, res) => {
  const transcription = req.body.TranscriptionText;
  const fromNumber = req.body.From;
  
  console.log(`Received voice transcription from ${fromNumber}: ${transcription}`);

  try {
    const eventData = await parseEventFromMessage(transcription, 'Voice');
    const result = await createWordPressEvent(eventData);

    const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
    
    if (result.success) {
      let confirmMsg = `✅ Event created from your call: ${eventData.title}\n📅 ${eventData.start_date} at ${eventData.start_time}`;
      if (eventData.validation_notes) {
        confirmMsg += `\n\n⚠️ Note: ${eventData.validation_notes}`;
      }
      confirmMsg += `\n\n🔗 ${result.eventUrl}`;
      
      await twilioClient.messages.create({
        body: confirmMsg,
        from: config.twilio.phoneNumber,
        to: fromNumber
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Voice processing error:', error);
    res.sendStatus(500);
  }
});

// Email Handler
app.post('/api/email', async (req, res) => {
  const emailBody = req.body.text || req.body.html;
  const emailSubject = req.body.subject;
  const fromEmail = req.body.from;
  
  console.log(`Received email from ${fromEmail}: ${emailSubject}`);

  try {
    const fullMessage = `Subject: ${emailSubject}\n\n${emailBody}`;
    const eventData = await parseEventFromMessage(fullMessage, 'Email');
    
    if (eventData.confidence === 'low') {
      console.log('Low confidence event, needs clarification');
      return res.sendStatus(200);
    }

    const result = await createWordPressEvent(eventData);
    console.log('Event created:', result);
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Email processing error:', error);
    res.sendStatus(500);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Manual event creation endpoint (for testing)
app.post('/api/events/create', async (req, res) => {
  try {
    const eventData = await parseEventFromMessage(req.body.message, 'Manual');
    const result = await createWordPressEvent(eventData);
    res.json({ eventData, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Calendar Agent server running on port ${PORT}`);
});