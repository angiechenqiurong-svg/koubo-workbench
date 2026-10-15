export const AI_PROVIDERS = Object.freeze({
  chatgpt: {label:'GPT / ChatGPT 套餐',baseUrl:'https://api.openai.com/v1',chatModel:'',keyUrl:'',models:[]},
  openai: {label:'GPT / OpenAI',baseUrl:'https://api.openai.com/v1',chatModel:'gpt-6-luna',keyUrl:'https://platform.openai.com/api-keys',models:['gpt-6-luna']},
  deepseek: {label:'DeepSeek',baseUrl:'https://api.deepseek.com',chatModel:'deepseek-flash',keyUrl:'https://platform.deepseek.com/api_keys',models:['deepseek-flash','deepseek-v4-pro']},
  gemini: {label:'Gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta',chatModel:'gemini-3.8-flash',keyUrl:'https://aistudio.google.com/apikey',models:['gemini-3.8-flash','gemini-3.5-flash-lite']}
});
