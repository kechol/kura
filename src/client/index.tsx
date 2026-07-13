import { render } from "preact";
import { Route, Switch } from "wouter-preact";
import "./styles.css";
import { BucketProvider } from "./bucket";
import { Layout } from "./components/Layout";
import { useDocumentTitle } from "./hooks";
import { bootRedirect } from "./lastdoc";
import { DocByTitle } from "./pages/DocByTitle";
import { DocDetail } from "./pages/DocDetail";
import { DocEdit } from "./pages/DocEdit";
import { DocList } from "./pages/DocList";
import { GraphPage } from "./pages/Graph";
import { Home } from "./pages/Home";
import { SearchPage } from "./pages/Search";
import { StatsPage } from "./pages/Stats";
import { TagsPage } from "./pages/Tags";
import { initTheme } from "./theme";

initTheme();
// Rewrites the URL before the router reads it, so "/" resumes the last document
bootRedirect();

function NotFound() {
  useDocumentTitle("404");
  return (
    <div class="page">
      <h1>404</h1>
      <p>ページが見つかりません。</p>
    </div>
  );
}

function App() {
  return (
    <BucketProvider>
      <Layout>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/docs" component={DocList} />
          <Route path="/docs/title/:title">{(params) => <DocByTitle title={params.title} />}</Route>
          <Route path="/docs/:key/edit">{(params) => <DocEdit docKey={params.key} />}</Route>
          <Route path="/docs/:key">{(params) => <DocDetail docKey={params.key} />}</Route>
          <Route path="/search" component={SearchPage} />
          <Route path="/tags" component={TagsPage} />
          <Route path="/graph" component={GraphPage} />
          <Route path="/stats" component={StatsPage} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </BucketProvider>
  );
}

const mount = document.getElementById("app");
if (mount) render(<App />, mount);
