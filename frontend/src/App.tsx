import { BrowserRouter, Route, Routes } from "react-router-dom"
import { HelloPage } from "./pages/HelloPage"

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HelloPage />} />
      </Routes>
    </BrowserRouter>
  )
}
