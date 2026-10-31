const React = require('react');
const css = require('./views.css');

/**
 * 共用控件样式（views.css）。视图同一时刻只挂载一个，所以在各视图根部渲染即可，
 * 不会在页面上留下重复的样式块。
 */
function SharedStyle() {
  return <style data-moshu-views="shared" dangerouslySetInnerHTML={{ __html: css }} />;
}

module.exports = { SharedStyle };
