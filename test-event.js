require('dotenv').config();
const axios = require('axios');

const testMessages = [
  {
    name: "Simple event",
    message: "GOP meeting next Tuesday at 7pm at the community center. Discussion about upcoming initiatives."
  },
  {
    name: "Event with wrong day",
    message: "Board meeting on Monday December 9th at 6:30pm at headquarters"
  },
  {
    name: "Casual format",
    message: "Hey, let's do a volunteer training session Dec 15 around 2pm at the office"
  }
];

async function testEvent(message) {
  try {
    console.log('\n' + '='.repeat(60));
    console.log('Testing message:', message.name);
    console.log('Message:', message.message);
    console.log('='.repeat(60));

    const response = await axios.post('http://localhost:3000/api/events/create', {
      message: message.message
    });

    console.log('\n✅ Event Data Parsed:');
    console.log(JSON.stringify(response.data.eventData, null, 2));
    
    if (response.data.result.success) {
      console.log('\n✅ WordPress Event Created!');
      console.log('Event ID:', response.data.result.eventId);
      console.log('Event URL:', response.data.result.eventUrl);
    } else {
      console.log('\n❌ WordPress Creation Failed:');
      console.log('Error:', response.data.result.error);
    }
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

async function runTests() {
  console.log('🚀 Starting Calendar Agent Tests\n');
  console.log('Make sure the server is running (npm start) before running tests!\n');

  for (const test of testMessages) {
    await testEvent(test);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ All tests completed!');
  console.log('='.repeat(60));
}

runTests().catch(console.error);