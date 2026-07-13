import { render } from "preact";
import { useEffect } from "preact/hooks";
import { Route, Switch, useLocation } from "wouter-preact";
import "./styles.css";
import { BucketProvider } from "./bucket";
import { Layout } from "./components/Layout";
import { CurrentDocProvider } from "./currentdoc";
import { useDocumentTitle } from "./hooks";
import { bootRedirect } from "./lastdoc";
import { ModalProvider } from "./modal";
import { DocByTitle } from "./pages/DocByTitle";
import { DocDetail } from "./pages/DocDetail";
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

/** Old bookmarks of the standalone editor land on the document itself */
function EditRedirect({ docKey }: { docKey: string }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate(`/docs/${encodeURIComponent(docKey)}`, { replace: true });
  }, [docKey, navigate]);
  return null;
}

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
      <CurrentDocProvider>
        <ModalProvider>
          <Layout>
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/docs" component={DocList} />
              <Route path="/docs/title/:title">
                {(params) => <DocByTitle title={params.title} />}
              </Route>
              {/* The separate editor is gone; the detail screen edits in place */}
              <Route path="/docs/:key/edit">
                {(params) => <EditRedirect docKey={params.key} />}
              </Route>
              <Route path="/docs/:key">{(params) => <DocDetail docKey={params.key} />}</Route>
              <Route path="/search" component={SearchPage} />
              <Route path="/tags" component={TagsPage} />
              <Route path="/graph" component={GraphPage} />
              <Route path="/stats" component={StatsPage} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </ModalProvider>
      </CurrentDocProvider>
    </BucketProvider>
  );
}

const mount = document.getElementById("app");
if (mount) render(<App />, mount);
