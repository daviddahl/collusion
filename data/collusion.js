var visualizations = {};
window.addEventListener('load', function(evt){
    // Wire up events
    window.currentVisualization = visualizations.clock;
    window.currentVisualization.emit('init');
    addon.emit('uiready');
//    document.defaultView.postMessage('pageloaded', '*');
});
