// Synthetic stalled server with an unavailable content script.
window.chrome = {
  runtime: {sendMessage: async message => message.type === 'health' ? {ok:true,engine:'agy',voices:[
    {name:'google',label:'Google Chirp 3 HD',ready:true,used:765000,limit:900000,unit:'bytes',voices:[{id:'th-TH-Chirp3-HD-Iapetus',label:'Iapetus — ชาย'}]},
    {name:'edge',label:'Edge',ready:true,voices:[{id:'th-TH-NiwatNeural',label:'Niwat — ชาย'}]},
  ]} : {ok:false}},
  storage: {local: {
    get: async () => ({ttsEngine:'google', ttsVoice:'th-TH-Chirp3-HD-Iapetus', dubbingEnabled:true, enabled:true, dualMode:true}),
    set: async () => {},
  }},
  tabs: {
    query: async () => [{id:1,url:'https://www.udemy.com/course/fixture/'}],
    sendMessage: async () => {throw new Error('No content script');},
  },
};
