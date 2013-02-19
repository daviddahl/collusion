var visualizations = {};
window.addEventListener('load', function(evt){
    // Wire up events
    window.currentVisualization = visualizations.clock;
    addon.emit('uiready');
    window.currentVisualization.emit('init');
//    document.defaultView.postMessage('pageloaded', '*');
});
