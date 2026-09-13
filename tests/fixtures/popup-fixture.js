// Synthetic stalled server with an unavailable content script.
window.chrome = {
  runtime: {sendMessage: () => new Promise(() => {})},
  storage: {local: {
    get: async () => ({ttsEngine:'edge', ttsVoice:'th-TH-NiwatNeural', dubbingEnabled:true, enabled:true, dualMode:true}),
    set: async () => {},
  }},
  tabs: {
    query: async () => [{id:1,url:'https://www.udemy.com/course/fixture/'}],
    sendMessage: async () => {throw new Error('No content script');},
  },
};
