// ===== 共享的 AI 模型配置（被 index.html / ai-cfg.html 共用） =====
// 使用 window. 挂载以保证跨 script 标签可访问（const 不会自动挂到 window）
// 避免两处各自维护导致不一致

window.KNOWN_MODELS = ['deepseek-v4-flash','qwen-max','glm-5.2','kimi-k2','doubao-seed-2.0-pro','ernie-5.0'];

window.MODEL_URLS = {
  'deepseek-v4-flash':'https://api.deepseek.com/v1',
  'qwen-max':'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'glm-5.2':'https://open.bigmodel.cn/api/paas/v4',
  'kimi-k2':'https://api.moonshot.cn/v1',
  'doubao-seed-2.0-pro':'https://ark.cn-beijing.volces.com/api/v3',
  'ernie-5.0':'https://qianfan.baidubce.com/v2',
};

window.MODEL_CONTEXTS = {
  'deepseek-v4-flash':1000000,
  'qwen-max':256000,
  'glm-5.2':1000000,
  'kimi-k2':256000,
  'doubao-seed-2.0-pro':256000,
  'ernie-5.0':128000,
};

window.modelSupportsVision = function(model){
  const m=(model||'').toLowerCase();
  if(/^(qwen|kimi|doubao|ernie)/.test(m))return true;
  if(/vl|vision|多模态/.test(m))return true;
  return false;
};

window.modelSupportsThinking = function(model){
  const m=(model||'').toLowerCase();
  if(/^(deepseek|qwen|glm|kimi|doubao|ernie)/.test(m))return true;
  if(/reason|think|reasoner|r1|-t1|o1|o3/.test(m))return true;
  return false;
};

window.getVisionCapability = function(aiCfg){
  const model=aiCfg.model;
  if(window.KNOWN_MODELS.includes(model)) return window.modelSupportsVision(model);
  return aiCfg.vision!==undefined ? aiCfg.vision : window.modelSupportsVision(model);
};
