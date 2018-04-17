import React from 'react';
import { Router, Scene } from 'react-native-router-flux';

import LoginPage from './Pages/LoginPage';
import SessionsPage from './Pages/SessionsPage';
import ScanPage from './Pages/ScanPage';
import CodeListPage from './Pages/CodeListPage';
import HistoryPage from './Pages/HistoryPage';

export default class App extends React.Component {
  render() {    
    return (
      <Router>
        <Scene key="root">
          <Scene key="login" component={LoginPage} title="Login" initial={true} />
          <Scene key="sessions" component={SessionsPage} title="Sesiones" />
          <Scene key="scan" component={ScanPage} title="Escáner" />
          <Scene key="codelist" component={CodeListPage} title="Listado" />
          <Scene key="history" component={HistoryPage} title="Historia" />
        </Scene>
      </Router>
    );
  }
}